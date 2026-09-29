import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE,
  clientIp,
  createGateway,
  createListener,
  originAllowed,
  parseClientFrame,
  parseOrigins,
} from "../gateway.mjs";
import { issueTicket } from "../../../lib/realtime.js";
import { FakePgClient, openClient, until, wait } from "./helpers.mjs";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const SECRET = "s".repeat(40);
const quiet = { log() {}, warn() {}, error() {} };

const gateways = [];
async function startGateway(options = {}) {
  const gw = createGateway({ log: quiet, secret: SECRET, ...options });
  const port = await gw.listen(0, "127.0.0.1");
  gateways.push(gw);
  return { gw, url: `ws://127.0.0.1:${port}`, port };
}
after(async () => {
  await Promise.all(gateways.map((g) => g.close()));
});

async function subscribed(url, election = E1, extra = {}, options) {
  const c = openClient(url, options);
  await c.opened;
  c.send({ type: "subscribe", election, ...extra });
  await until(() => c.frames.find((f) => f.type === "subscribed") || c.closeCode);
  return c;
}

/* ── pure helpers ── */

test("parseClientFrame accepts subscribe with a UUID and lowercases it", () => {
  assert.deepEqual(parseClientFrame(JSON.stringify({ type: "subscribe", election: E1.toUpperCase() })), {
    type: "subscribe",
    election: E1,
    ticket: null,
  });
  assert.deepEqual(parseClientFrame('{"type":"ping"}'), { type: "ping" });
});

test("parseClientFrame rejects anything else", () => {
  for (const raw of [
    "not json",
    "[]",
    "null",
    '{"type":"subscribe","election":"x"}',
    `{"type":"subscribe","election":"${"a".repeat(5000)}"}`,
    `{"type":"subscribe","election":"${E1}","ticket":42}`,
    '{"type":"publish"}',
  ]) {
    assert.ok(parseClientFrame(raw).error, raw.slice(0, 40));
  }
});

test("origin allowlist", () => {
  const allowed = parseOrigins(" https://vote.example.org/ , http://localhost:3000");
  assert.ok(originAllowed("https://vote.example.org", allowed));
  assert.ok(originAllowed("HTTPS://VOTE.EXAMPLE.ORG", allowed));
  assert.ok(!originAllowed("https://evil.example", allowed));
  assert.ok(originAllowed(undefined, allowed), "non-browser clients carry no Origin");
  assert.ok(originAllowed("https://anything", null), "no allowlist configured");
  assert.equal(parseOrigins(""), null);
});

test("clientIp only trusts X-Forwarded-For when told to", () => {
  const req = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: { remoteAddress: "9.9.9.9" } };
  assert.equal(clientIp(req), "9.9.9.9");
  assert.equal(clientIp(req, true), "2.2.2.2");
});

/* ── WebSocket limits ── */

test("subscribe, event relay and room isolation", async () => {
  const { gw, url } = await startGateway();
  const a = await subscribed(url, E1.toUpperCase());
  const b = await subscribed(url, E2);
  assert.deepEqual(a.frames[0], { type: "subscribed", election: E1, live: true });
  gw.handleNotify(JSON.stringify({ electionId: E1, event: "state_change", data: { status: "voting" } }));
  await until(() => a.frames.some((f) => f.type === "event"));
  await wait(30);
  assert.deepEqual(a.frames.at(-1), { type: "event", event: "state_change", data: { status: "voting" } });
  assert.ok(!b.frames.some((f) => f.type === "event"), "other room saw nothing");
  a.ws.close();
  b.ws.close();
});

test("a frame over 4 KiB closes the socket (no 100 MiB frames)", async () => {
  const { url } = await startGateway();
  const c = openClient(url);
  await c.opened;
  c.send({ type: "subscribe", election: E1, pad: "x".repeat(5000) });
  await until(() => c.closeCode);
  assert.equal(c.closeCode, 1009);
});

test("invalid election ids and unknown frames close the socket without an echo", async () => {
  const { url } = await startGateway();
  for (const frame of [{ type: "subscribe", election: "<script>" }, { type: "broadcast" }, "junk"]) {
    const c = openClient(url);
    await c.opened;
    c.send(frame);
    await until(() => c.closeCode);
    assert.equal(c.closeCode, CLOSE.BAD_FRAME);
    assert.equal(c.frames.length, 0);
  }
});

test("a socket that never subscribes is closed", async () => {
  const { url } = await startGateway({ subscribeTimeoutMs: 100 });
  const c = openClient(url);
  await c.opened;
  await until(() => c.closeCode);
  assert.equal(c.closeCode, CLOSE.SUBSCRIBE_TIMEOUT);
});

test("frame flooding closes the socket", async () => {
  const { url } = await startGateway({ maxFramesPerWindow: 5 });
  const c = await subscribed(url);
  for (let i = 0; i < 10; i++) c.send({ type: "ping" });
  await until(() => c.closeCode);
  assert.equal(c.closeCode, CLOSE.RATE_LIMIT);
});

test("a browser origin outside the allowlist is refused at the handshake", async () => {
  const { url } = await startGateway({ allowedOrigins: parseOrigins("https://vote.example.org") });
  const bad = openClient(url, { origin: "https://evil.example" });
  assert.equal(await bad.opened, false);
  assert.equal(bad.unexpected, 403);
  const good = openClient(url, { origin: "https://vote.example.org" });
  assert.equal(await good.opened, true);
  good.ws.close();
});

test("connections per IP are capped and slots are released on close", async () => {
  const { gw, url } = await startGateway({ maxConnectionsPerIp: 2 });
  const a = openClient(url);
  const b = openClient(url);
  assert.equal(await a.opened, true);
  assert.equal(await b.opened, true);
  const c = openClient(url);
  assert.equal(await c.opened, false);
  assert.equal(c.unexpected, 429);
  a.ws.close();
  await until(() => gw.stats().connections === 1);
  const d = openClient(url);
  assert.equal(await d.opened, true);
  b.ws.close();
  d.ws.close();
});

/* ── tickets and scopes ── */

test("with tickets required, a subscribe needs a valid ticket for that election", async () => {
  const { url } = await startGateway({ requireTicket: true });

  const none = await subscribed(url);
  assert.deepEqual(none.frames[0], { type: "error", code: "ticket_required" });
  await until(() => none.closeCode);
  assert.equal(none.closeCode, CLOSE.BAD_TICKET);

  const other = await subscribed(url, E1, { ticket: issueTicket({ electionId: E2 }, SECRET) });
  assert.equal(other.frames[0].code, "bad_ticket");

  const forged = await subscribed(url, E1, { ticket: issueTicket({ electionId: E1 }, "f".repeat(40)) });
  assert.equal(forged.frames[0].code, "bad_ticket");

  const ok = await subscribed(url, E1, { ticket: issueTicket({ electionId: E1 }, SECRET) });
  assert.equal(ok.frames[0].type, "subscribed");
  ok.ws.close();
});

test("admin-audience events reach only admin-scope sockets", async () => {
  const { gw, url } = await startGateway({ requireTicket: true });
  const voter = await subscribed(url, E1, { ticket: issueTicket({ electionId: E1, scope: "voter" }, SECRET) });
  const admin = await subscribed(url, E1, { ticket: issueTicket({ electionId: E1, scope: "admin" }, SECRET) });
  gw.handleNotify(JSON.stringify({ electionId: E1, event: "tally", data: { n: 3 }, audience: "admin" }));
  gw.handleNotify(JSON.stringify({ electionId: E1, event: "state_change", data: null }));
  await until(() => voter.frames.some((f) => f.event === "state_change"));
  await until(() => admin.frames.some((f) => f.event === "state_change"));
  assert.ok(admin.frames.some((f) => f.event === "tally"));
  assert.ok(!voter.frames.some((f) => f.event === "tally"));
  voter.ws.close();
  admin.ws.close();
});

/* ── LISTEN loss and resync ── */

test("listener reconnects after a drop and the gateway tells clients to resync", async () => {
  const clients = [];
  let live = false;
  const { gw, url, port } = await startGateway({ isLive: () => live });
  const listener = createListener({
    createClient: () => {
      const c = new FakePgClient();
      clients.push(c);
      return c;
    },
    onPayload: (p) => gw.handleNotify(p),
    onLiveChange: (value, info) => {
      live = value;
      gw.handleLiveChange(value, info);
    },
    log: quiet,
    minRetryMs: 300,
  });
  await listener.start();
  assert.equal(listener.live, true);

  const voter = await subscribed(url);
  clients[0].notify({ electionId: E1, event: "state_change", data: { n: 1 } });
  await until(() => voter.frames.some((f) => f.data?.n === 1));

  // Postgres terminates the LISTEN backend.
  clients[0].emit("error", new Error("terminating connection due to administrator command"));
  await until(() => voter.frames.some((f) => f.type === "status" && f.live === false));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 503);

  // An event sent through the dead connection is ignored, not relayed twice later.
  clients[0].notify({ electionId: E1, event: "state_change", data: { n: 2 } });

  await until(() => clients.length === 2 && listener.live);
  await until(() => voter.frames.some((f) => f.event === "resync"));
  const tail = voter.frames.slice(-2);
  assert.deepEqual(tail, [
    { type: "status", live: true },
    { type: "event", event: "resync", data: null },
  ]);
  assert.ok(!voter.frames.some((f) => f.data?.n === 2));
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);

  clients[1].notify({ electionId: E1, event: "state_change", data: { n: 3 } });
  await until(() => voter.frames.some((f) => f.data?.n === 3));
  await listener.stop();
  voter.ws.close();
});

test("a hung health query counts as a dead connection", async () => {
  const clients = [];
  const changes = [];
  const listener = createListener({
    createClient: () => {
      const c = new FakePgClient({ hangQueries: clients.length === 0 });
      clients.push(c);
      return c;
    },
    onPayload: () => {},
    onLiveChange: (v, info) => changes.push([v, info.first]),
    log: quiet,
    healthIntervalMs: 30,
    healthTimeoutMs: 30,
    minRetryMs: 10,
  });
  await listener.start();
  await until(() => clients.length === 2 && listener.live);
  assert.deepEqual(changes, [
    [true, true],
    [false, false],
    [true, false],
  ]);
  assert.ok(clients[0].ended);
  await listener.stop();
});

test("the first LISTEN attempt failing rejects start()", async () => {
  const listener = createListener({
    createClient: () => new FakePgClient({ failConnect: true }),
    onPayload: () => {},
    log: quiet,
  });
  await assert.rejects(listener.start(), /connect refused/);
  await listener.stop();
});

test("failed reconnects back off and keep trying", async () => {
  let n = 0;
  const listener = createListener({
    createClient: () => new FakePgClient({ failConnect: n++ > 0 && n < 4 }),
    onPayload: () => {},
    log: quiet,
    minRetryMs: 10,
  });
  await listener.start();
  listener.kill("test");
  assert.equal(listener.live, false);
  await until(() => listener.live, { timeout: 3000 });
  assert.ok(n >= 4);
  await listener.stop();
});
