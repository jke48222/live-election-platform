import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  connectElection,
  connectionStatus,
  heartbeatAction,
  syncDue,
} from "../../../lib/realtime-client.js";
import { createGateway } from "../gateway.mjs";
import { until, wait } from "./helpers.mjs";

const E1 = "11111111-1111-4111-8111-111111111111";
const quiet = { log() {}, warn() {}, error() {} };
const FAST = { tickMs: 10, heartbeatMs: 80, pongTimeoutMs: 60, pollDownMs: 50, pollLiveMs: 400, minBackoffMs: 20, maxBackoffMs: 80 };

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

/* ── pure state machine ── */

test("syncDue polls fast while not live, slowly while live, and at once when never synced", () => {
  assert.equal(syncDue({ live: true, lastSyncAt: null, now: 0 }), true);
  assert.equal(syncDue({ live: false, lastSyncAt: 0, now: 3_999 }), false);
  assert.equal(syncDue({ live: false, lastSyncAt: 0, now: 4_000 }), true);
  assert.equal(syncDue({ live: true, lastSyncAt: 0, now: 14_999 }), false);
  assert.equal(syncDue({ live: true, lastSyncAt: 0, now: 15_000 }), true);
});

test("heartbeatAction pings on schedule and declares an unanswered ping dead", () => {
  assert.equal(heartbeatAction({ lastPingAt: 0, awaitingPong: false, now: 14_999 }), "wait");
  assert.equal(heartbeatAction({ lastPingAt: 0, awaitingPong: false, now: 15_000 }), "ping");
  assert.equal(heartbeatAction({ lastPingAt: 0, awaitingPong: true, now: 4_999 }), "wait");
  assert.equal(heartbeatAction({ lastPingAt: 0, awaitingPong: true, now: 5_000 }), "dead");
});

test("connectionStatus", () => {
  assert.equal(connectionStatus({ socketOpen: false, subscribed: true, serverLive: true }), "closed");
  assert.equal(connectionStatus({ socketOpen: true, subscribed: false, serverLive: true }), "reconnecting");
  assert.equal(connectionStatus({ socketOpen: true, subscribed: true, serverLive: false }), "degraded");
  assert.equal(connectionStatus({ socketOpen: true, subscribed: true, serverLive: true }), "open");
});

/* ── against a real gateway ── */

async function gateway(options = {}) {
  let live = true;
  const gw = createGateway({ log: quiet, isLive: () => live, ...options });
  const port = await gw.listen(0, "127.0.0.1");
  cleanups.push(() => gw.close());
  return { gw, url: `ws://127.0.0.1:${port}`, setLive: (v) => (live = v) };
}

function track(url, extra = {}) {
  const log = { statuses: [], syncs: [], events: [] };
  const conn = connectElection(E1, {
    url,
    ...FAST,
    onStatus: (s) => log.statuses.push(s),
    onSync: (r) => log.syncs.push(r),
    onEvent: (e, d) => log.events.push([e, d]),
    ...extra,
  });
  cleanups.push(() => conn.close());
  return { conn, log };
}

test("subscribes, then syncs, then relays events", async () => {
  const { gw, url } = await gateway();
  const { conn, log } = track(url);
  await until(() => conn.status === "open");
  assert.equal(log.syncs[0], "subscribed");
  gw.fanout(E1, "state_change", { status: "voting" });
  await until(() => log.events.length);
  assert.deepEqual(log.events[0], ["state_change", { status: "voting" }]);
  conn.close();
});

test("gateway losing and regaining LISTEN: degraded, fast polling, then open and a resync", async () => {
  const { gw, url, setLive } = await gateway();
  const { conn, log } = track(url);
  await until(() => conn.status === "open");

  setLive(false);
  gw.handleLiveChange(false);
  await until(() => conn.status === "degraded");
  const before = log.syncs.length;
  await wait(200);
  assert.ok(log.syncs.length - before >= 2, "polls while the gateway is not live");

  setLive(true);
  gw.handleLiveChange(true, { first: false });
  await until(() => log.syncs.includes("resync"));
  assert.equal(conn.status, "open");
  assert.ok(log.events.some(([e]) => e === "resync"));
  // A page that only refetches on 'open' (the old contract) still refetches.
  assert.deepEqual(log.statuses.slice(-2), ["degraded", "open"]);
  conn.close();
});

test("with no gateway at all the page still polls", async () => {
  const { log, conn } = track("ws://127.0.0.1:9");
  await wait(250);
  assert.ok(log.syncs.filter((r) => r === "poll").length >= 3);
  assert.notEqual(conn.status, "open");
  conn.close();
});

test("a half-open socket (no pong) is dropped and replaced", async () => {
  // A server that accepts and acknowledges the subscribe, then goes silent,
  // like a phone whose Wi-Fi vanished without a FIN.
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.once("message", () => ws.send(JSON.stringify({ type: "subscribed", election: E1, live: true })));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => r());
      })
  );
  const { conn, log } = track(`ws://127.0.0.1:${server.address().port}`);
  await until(() => connections >= 2, { timeout: 3000 });
  assert.ok(log.statuses.includes("closed"));
  await until(() => conn.status === "open");
  conn.close();
});

test("a subscribe that is never answered is abandoned", async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on("connection", () => connections++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => r());
      })
  );
  const { conn } = track(`ws://127.0.0.1:${server.address().port}`, { connectTimeoutMs: 100 });
  await until(() => connections >= 2, { timeout: 3000 });
  conn.close();
});

test("getTicket is called for every connection and its ticket is sent", async () => {
  const { issueTicket } = await import("../../../lib/realtime.js");
  const secret = "t".repeat(40);
  const { gw, url } = await gateway({ requireTicket: true, secret });
  let calls = 0;
  const { conn } = track(url, {
    getTicket: async () => {
      calls++;
      return issueTicket({ electionId: E1 }, secret);
    },
  });
  await until(() => conn.status === "open");
  // Drop every socket; the client must fetch a fresh ticket to get back in.
  for (const ws of gw.wss.clients) ws.terminate();
  await until(() => calls >= 2 && conn.status === "open", { timeout: 3000 });
  conn.close();
});

test("close() stops reconnecting and polling", async () => {
  const { url } = await gateway();
  const { conn, log } = track(url);
  await until(() => conn.status === "open");
  conn.close();
  const n = log.syncs.length;
  await wait(150);
  assert.equal(log.syncs.length, n);
  assert.equal(conn.status, "closed");
});
