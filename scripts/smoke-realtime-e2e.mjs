#!/usr/bin/env node
/**
 * Full-stack realtime proof, with subscribe tickets obtained the way the
 * pages get them:
 *
 *   - a voter checks in (POST /api/checkin) and subscribes with the ticket
 *     the check-in returns, as components/VoterApp.js does;
 *   - the admin asks POST /api/realtime/ticket with their session cookie and
 *     subscribes with that, as app/admin/page.js does;
 *   - the real /api/state route launches a poll, and both sockets must get
 *     the state_change (route -> withOrg -> pg_notify -> gateway -> WS).
 *
 * Every subscribe has a deadline and fails on close, so a gateway that
 * refuses the socket fails this script instead of letting it exit 0.
 *
 * REALTIME_EXPECT_TICKETS says what the gateway under test should do with a
 * subscribe that has no ticket, as in services/realtime/verify-realtime.mjs:
 * 1 means it must refuse it (any gateway outside NODE_ENV=development), 0
 * means it must accept it, and unset only reports which it did.
 *
 *   npm run dev          # terminal 1
 *   npm run realtime     # terminal 2
 *   node scripts/smoke-realtime-e2e.mjs
 */
import crypto from "node:crypto";
import { WebSocket } from "ws";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const RT = process.env.REALTIME_TEST_URL || "ws://localhost:3001";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";
const PIN = process.env.DEMO_PIN || "197526";
const EXPECT_TICKETS = process.env.REALTIME_EXPECT_TICKETS;
const SUBSCRIBE_TIMEOUT_MS = 5000;
const EVENT_TIMEOUT_MS = 5000;
const BAD_TICKET_CLOSE = 4401;

// A fresh device and name each run, so a run that died halfway cannot leave
// a check-in behind that makes the next run's name a duplicate.
const DEVICE = crypto.randomBytes(32).toString("hex");
const VOTER_NAME = `Realtime Smoke ${DEVICE.slice(0, 8)}`;

let failures = 0;
let finished = false;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await wait(25);
  }
  return true;
}

async function api(path, { method = "GET", body, admin = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && setCookie.includes("ev_session=")) cookie = setCookie.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Opens a socket and subscribes to one election. `result` settles once: with
 * { ok: true } on 'subscribed', or { ok: false, code, reason } when the
 * socket closes or errors first, or when the deadline passes.
 */
function subscribe(electionId, ticket) {
  const ws = new WebSocket(RT);
  const events = [];
  let errorCode = null;
  const result = new Promise((resolve) => {
    let settled = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, reason: `no 'subscribed' within ${SUBSCRIBE_TIMEOUT_MS} ms` });
      ws.terminate();
    }, SUBSCRIBE_TIMEOUT_MS);
    ws.on("open", () => {
      const frame = { type: "subscribe", election: electionId };
      if (ticket) frame.ticket = ticket;
      ws.send(JSON.stringify(frame));
    });
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type === "subscribed") settle({ ok: true });
      else if (m.type === "error") errorCode = m.code;
      else if (m.type === "event") events.push(m);
    });
    ws.on("close", (code) =>
      settle({ ok: false, code, reason: `closed with ${code}${errorCode ? ` (${errorCode})` : ""}` })
    );
    ws.on("error", (err) => settle({ ok: false, reason: err.message }));
  });
  return { ws, events, result };
}

const describe = (r) => (r.ok ? "subscribed" : r.reason);

async function resetElection(electionId) {
  await api("/api/state", { method: "POST", admin: true, body: { action: "finalize", election_id: electionId } });
  await api("/api/state", { method: "POST", admin: true, body: { action: "reset_all_results", election_id: electionId } });
}

async function main() {
  console.log(`realtime end to end against ${RT}`);
  const login = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  ok(login.status === 200 && !!cookie, `admin signed in (HTTP ${login.status})`);

  const read = await api("/api/election?org=demo&election=spring-2026");
  const electionId = read.json?.election?.id;
  const positionId = read.json?.positions?.[0]?.id;
  ok(!!electionId && !!positionId, "resolved demo election + position");
  if (!electionId || !positionId || !cookie) return;

  const sockets = [];
  try {
    await resetElection(electionId);

    // The voter's ticket comes with the check-in, as on the voter page.
    const checkin = await api("/api/checkin", {
      method: "POST",
      body: { election_id: electionId, display_name: VOTER_NAME, device_hash: DEVICE, pin: PIN },
    });
    const voterTicket = checkin.json?.ticket;
    ok(checkin.status === 200 && typeof voterTicket === "string" && voterTicket.length > 0,
      `voter check-in returned a subscribe ticket (HTTP ${checkin.status})`);

    // A checked-in device can also ask for a fresh ticket.
    const refreshed = await api("/api/realtime/ticket", {
      method: "POST",
      body: { election_id: electionId, device_hash: DEVICE },
    });
    ok(refreshed.status === 200 && refreshed.json?.scope === "voter" && !!refreshed.json?.ticket,
      `/api/realtime/ticket gave the checked-in device a voter ticket (HTTP ${refreshed.status})`);

    const stranger = await api("/api/realtime/ticket", {
      method: "POST",
      body: { election_id: electionId, device_hash: crypto.randomBytes(32).toString("hex") },
    });
    ok(stranger.status === 401,
      `/api/realtime/ticket refused a device that never checked in (HTTP ${stranger.status})`);

    // The admin's ticket comes from the ticket route, as in the admin console.
    const adminTicketRes = await api("/api/realtime/ticket", {
      method: "POST",
      admin: true,
      body: { election_id: electionId },
    });
    const adminTicket = adminTicketRes.json?.ticket;
    ok(adminTicketRes.status === 200 && adminTicketRes.json?.scope === "admin" && !!adminTicket,
      `/api/realtime/ticket gave the admin an admin ticket (HTTP ${adminTicketRes.status})`);

    // A voter ticket edited to claim admin scope keeps its old signature. The
    // gateway checks any ticket it is given, so this holds in every mode.
    if (voterTicket) {
      const [version, body, sig] = voterTicket.split(".");
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      const edited = Buffer.from(JSON.stringify({ ...claims, s: "admin" })).toString("base64url");
      const forged = subscribe(electionId, [version, edited, sig].join("."));
      sockets.push(forged.ws);
      const r = await forged.result;
      ok(!r.ok && r.code === BAD_TICKET_CLOSE,
        `a voter ticket edited to claim admin scope is refused (${describe(r)})`);
    }

    const bare = subscribe(electionId, null);
    sockets.push(bare.ws);
    const br = await bare.result;
    if (EXPECT_TICKETS === "1") {
      ok(!br.ok && br.code === BAD_TICKET_CLOSE, `a subscribe with no ticket is refused (${describe(br)})`);
    } else if (EXPECT_TICKETS === "0") {
      ok(br.ok, `a subscribe with no ticket is accepted in development (${describe(br)})`);
    } else {
      console.log(`  - a subscribe with no ticket: ${describe(br)} ` +
        "(set REALTIME_EXPECT_TICKETS to 1 or 0 to check it)");
    }
    bare.ws.terminate();

    const voter = subscribe(electionId, voterTicket);
    const admin = subscribe(electionId, adminTicket);
    sockets.push(voter.ws, admin.ws);
    const [vr, ar] = await Promise.all([voter.result, admin.result]);
    ok(vr.ok, `voter socket subscribed with the check-in ticket (${describe(vr)})`);
    ok(ar.ok, `admin socket subscribed with the admin ticket (${describe(ar)})`);
    if (!vr.ok || !ar.ok) return;

    // Drop anything left over from setup.
    await wait(200);
    voter.events.length = 0;
    admin.events.length = 0;

    const launch = await api("/api/state", {
      method: "POST",
      admin: true,
      body: { action: "launch", election_id: electionId, position_id: positionId, duration: 60 },
    });
    ok(launch.status === 200, `admin launched poll via /api/state (HTTP ${launch.status})`);

    for (const [who, sock] of [["voter", voter], ["admin", admin]]) {
      const got = await until(() => sock.events.some((e) => e.event === "state_change"), EVENT_TIMEOUT_MS);
      const change = sock.events.find((e) => e.event === "state_change");
      ok(got, `${who} socket received state_change from the route's pg_notify`);
      ok(change?.data?.status === "voting" && change?.data?.active_position_id === positionId,
        `${who} state_change payload carries voting + active_position_id`);
    }
  } finally {
    // Leave the election waiting and remove this run's check-in.
    await resetElection(electionId).catch(() => {});
    await api("/api/checkin", {
      method: "DELETE",
      admin: true,
      body: { election_id: electionId, device_hash: DEVICE },
    }).catch(() => {});
    for (const ws of sockets) ws.terminate();
  }
}

// If the event loop drains before main() reports, the checks did not all
// run, and that counts as a failure rather than a silent exit 0.
process.on("beforeExit", () => {
  if (!finished) {
    console.log("  ✗ the script stopped before every check ran");
    process.exitCode = 1;
  }
});

main()
  .then(() => {
    finished = true;
    console.log(failures === 0 ? "\nREALTIME E2E PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    finished = true;
    console.error(err);
    process.exit(1);
  });
