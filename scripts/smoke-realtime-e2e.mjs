#!/usr/bin/env node
/**
 * Full-stack realtime proof: a WebSocket client subscribed to an election (as
 * the voter page does) receives a state_change when the REAL /api/state route
 * launches a poll — exercising route -> withOrg -> pg_notify -> gateway -> WS.
 *
 *   npm run dev          # terminal 1
 *   npm run realtime     # terminal 2
 *   node scripts/smoke-realtime-e2e.mjs
 */
import { WebSocket } from "ws";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const RT = process.env.REALTIME_TEST_URL || "ws://localhost:3001";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";

let failures = 0;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, admin = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && setCookie.includes("ev_session=")) cookie = setCookie.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  const read = await api("/api/election?org=demo&election=spring-2026");
  const electionId = read.json?.election?.id;
  const positionId = read.json?.positions?.[0]?.id;
  ok(!!electionId && !!positionId, "resolved demo election + position");

  // Subscribe a WS client exactly like the voter page.
  const ws = new WebSocket(RT);
  const events = [];
  const subscribed = new Promise((resolve) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", election: electionId })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "subscribed") resolve();
      if (m.type === "event") events.push(m);
    });
  });
  await subscribed;
  ok(true, "voter WS subscribed to election room");

  // Clean slate, then launch via the real API route.
  await api("/api/state", { method: "POST", admin: true, body: { action: "finalize", election_id: electionId } });
  await api("/api/state", { method: "POST", admin: true, body: { action: "reset_all_results", election_id: electionId } });
  await wait(200);
  events.length = 0;

  const launch = await api("/api/state", { method: "POST", admin: true, body: { action: "launch", election_id: electionId, position_id: positionId, duration: 60 } });
  ok(launch.status === 200, "admin launched poll via /api/state");

  await wait(500);
  const stateChange = events.find((e) => e.event === "state_change");
  ok(!!stateChange, "voter WS received state_change from the route's pg_notify");
  ok(stateChange?.data?.status === "voting" && stateChange?.data?.active_position_id === positionId,
    "state_change payload carries voting + active_position_id");

  // cleanup → leave the election in a clean waiting state
  await api("/api/state", { method: "POST", admin: true, body: { action: "finalize", election_id: electionId } });
  await api("/api/state", { method: "POST", admin: true, body: { action: "reset_all_results", election_id: electionId } });
  ws.close();

  console.log(failures === 0 ? "\nREALTIME E2E PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
