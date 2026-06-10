#!/usr/bin/env node
/**
 * Proves the realtime path end-to-end: pg_notify (what API routes emit) is
 * relayed by the gateway to the correct election room, and ONLY that room.
 *
 * Assumes the gateway is already running (npm run realtime). Then:
 *   node --env-file=.env.local services/realtime/verify-realtime.mjs
 *
 *   1. Open WS client A subscribed to election E1, client B subscribed to E2.
 *   2. emit() an event on E1 via pg_notify.
 *   3. Assert A received it, B did not (room isolation).
 */
import { WebSocket } from "ws";
import pg from "pg";
import { emit } from "../../lib/realtime.js";

const RT_URL = process.env.REALTIME_TEST_URL || "ws://localhost:3001";
const PG_URL =
  process.env.APP_DATABASE_URL || "postgres://app:app_local_dev@localhost:5432/elections";
const E1 = "11111111-1111-1111-1111-111111111111";
const E2 = "22222222-2222-2222-2222-222222222222";

let failures = 0;
const assert = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(election) {
  const ws = new WebSocket(RT_URL);
  const received = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "event") received.push(m);
  });
  const ready = new Promise((resolve) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "subscribed") resolve();
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", election })));
  });
  return { ws, received, ready };
}

async function main() {
  const a = client(E1);
  const b = client(E2);
  await Promise.all([a.ready, b.ready]);

  const pgClient = new pg.Client({ connectionString: PG_URL });
  await pgClient.connect();
  try {
    await emit(pgClient, E1, "state_change", { status: "voting", position_id: "abc" });
    await wait(300);

    assert(a.received.length === 1, "client in room E1 received the event");
    assert(
      a.received[0]?.event === "state_change" && a.received[0]?.data?.status === "voting",
      "event payload arrived intact"
    );
    assert(b.received.length === 0, "client in room E2 did NOT receive E1's event (isolation)");
  } finally {
    await pgClient.end();
    a.ws.close();
    b.ws.close();
  }

  console.log(failures === 0 ? "\nREALTIME PATH VERIFIED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
