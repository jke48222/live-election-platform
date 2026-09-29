#!/usr/bin/env node
/**
 * Proves the realtime path end to end against a running gateway and Postgres:
 *
 *   1. pg_notify (what API routes emit) reaches clients in that election's
 *      room and no other room.
 *   2. A device_hash never leaves the server; clients see a voter_tag.
 *   3. Oversized frames and malformed election ids are refused.
 *   4. A signed ticket subscribes; a forged one is refused. With
 *      REALTIME_EXPECT_TICKETS=1 a subscribe without a ticket must be refused
 *      (set it when the gateway runs outside NODE_ENV=development); with 0 it
 *      must be accepted; unset, the script only reports which mode it found.
 *   5. When Postgres kills the gateway's LISTEN connection, subscribed clients
 *      are told live:false, then live:true and 'resync' once it reconnects.
 *
 * Assumes the gateway is already running (npm run realtime). Then:
 *   node --env-file=.env.local services/realtime/verify-realtime.mjs
 *
 * Every client here subscribes with a signed ticket, so the checks pass
 * whether or not the gateway requires one. REALTIME_SECRET must match the
 * gateway's.
 */
import { WebSocket } from "ws";
import pg from "pg";
import { emit, issueTicket, voterTag } from "../../lib/realtime.js";

const RT_URL = process.env.REALTIME_TEST_URL || "ws://localhost:3001";
const PG_URL =
  process.env.APP_DATABASE_URL || "postgres://app:app_local_dev@localhost:5432/elections";
const E1 = "11111111-1111-1111-1111-111111111111";
const E2 = "22222222-2222-2222-2222-222222222222";
const HASH = "ab".repeat(32);

let failures = 0;
const assert = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await wait(20);
  }
  return true;
}

/**
 * Opens a socket and subscribes to `election`. A valid ticket for that
 * election is added unless `extra` sets `ticket` itself; pass
 * { ticket: undefined } to subscribe without one.
 */
function client(election, extra = {}) {
  if (election && !("ticket" in extra)) extra = { ...extra, ticket: issueTicket({ electionId: election }) };
  const ws = new WebSocket(RT_URL);
  const state = { ws, frames: [], received: [], closeCode: null };
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    state.frames.push(m);
    if (m.type === "event") state.received.push(m);
  });
  state.ready = new Promise((resolve) => {
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "subscribed") resolve(true);
    });
    ws.on("close", (code) => {
      state.closeCode = code;
      resolve(false);
    });
    ws.on("open", () => {
      if (election) ws.send(JSON.stringify({ type: "subscribe", election, ...extra }));
    });
  });
  return state;
}

async function main() {
  const a = client(E1);
  const b = client(E2);
  await Promise.all([a.ready, b.ready]);

  const pgClient = new pg.Client({ connectionString: PG_URL });
  await pgClient.connect();
  try {
    console.log("relay and room isolation");
    await emit(pgClient, E1, "state_change", { status: "voting", position_id: "abc" });
    await until(() => a.received.length >= 1, 2000);
    await wait(100);
    assert(a.received.length === 1, "client in room E1 received the event");
    assert(
      a.received[0]?.event === "state_change" && a.received[0]?.data?.status === "voting",
      "event payload arrived intact"
    );
    assert(b.received.length === 0, "client in room E2 did NOT receive E1's event (isolation)");

    console.log("no credentials in broadcasts");
    await emit(pgClient, E1, "checkin_verified", { device_hash: HASH });
    await until(() => a.received.length >= 2, 2000);
    const verified = a.received[1];
    assert(verified?.event === "checkin_verified", "checkin_verified arrived");
    assert(!JSON.stringify(verified).includes(HASH), "the device hash is not in the frame");
    assert(verified?.data?.voter_tag === voterTag(E1, HASH), "the frame carries the voter tag");

    console.log("limits on anonymous clients");
    const big = client(null);
    await new Promise((r) => big.ws.on("open", r));
    big.ws.send(JSON.stringify({ type: "subscribe", election: E1, pad: "x".repeat(8192) }));
    await until(() => big.closeCode !== null, 2000);
    assert(big.closeCode === 1009, `an 8 KiB frame closes the socket (code ${big.closeCode})`);

    const badId = client("not-a-uuid");
    assert((await badId.ready) === false && badId.closeCode === 1008, "a malformed election id is refused");
    assert(!badId.frames.length, "nothing is echoed back for a refused subscribe");

    console.log("tickets");
    const ticketed = client(E1, { ticket: issueTicket({ electionId: E1 }) });
    assert((await ticketed.ready) === true, "a signed ticket subscribes");
    ticketed.ws.close();
    const forged = client(E1, { ticket: issueTicket({ electionId: E1 }, "f".repeat(40)) });
    assert((await forged.ready) === false && forged.closeCode === 4401, "a forged ticket is refused");
    const bare = client(E1, { ticket: undefined });
    const bareOk = await bare.ready;
    bare.ws.close();
    const expectTickets = process.env.REALTIME_EXPECT_TICKETS;
    if (expectTickets === "1") {
      assert(
        bareOk === false && bare.closeCode === 4401 && bare.frames[0]?.code === "ticket_required",
        "a subscribe without a ticket is refused"
      );
    } else if (expectTickets === "0") {
      assert(bareOk === true, "a subscribe without a ticket is accepted (development)");
    } else {
      console.log(`  - the gateway ${bareOk ? "does not require" : "requires"} tickets (set REALTIME_EXPECT_TICKETS to check)`);
    }

    console.log("LISTEN loss and resync");
    const { rows } = await pgClient.query(
      "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = 'realtime-gateway-listen'"
    );
    assert(rows.length === 1 && rows[0].ok, "terminated the gateway's LISTEN backend");
    assert(
      await until(() => a.frames.some((f) => f.type === "status" && f.live === false)),
      "subscribed client was told live:false"
    );
    assert(
      await until(() => a.received.some((e) => e.event === "resync"), 15000),
      "subscribed client got 'resync' after the gateway reconnected"
    );
    const n = a.received.length;
    await emit(pgClient, E1, "state_change", { status: "waiting" });
    assert(await until(() => a.received.length > n, 2000), "events flow again after the reconnect");
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
