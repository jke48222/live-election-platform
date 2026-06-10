#!/usr/bin/env node
/**
 * End-to-end smoke test of the Supabase-free backend against a running
 * `next dev`. Admin actions authenticate via a real user session (Phase 2),
 * not the retired admin password.
 *
 *   npm run dev · npm run realtime · node scripts/smoke-backend.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";
const DEVICE = "a".repeat(64);

let failures = 0;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && setCookie.includes("ev_session=")) {
    cookie = setCookie.split(";")[0];
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  // Sign in as the seeded demo owner.
  const login = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  ok(login.status === 200 && cookie.includes("ev_session="), "login as demo owner");

  const read = await api("/api/election?org=demo&election=spring-2026");
  ok(read.status === 200, "public election read 200");
  const electionId = read.json?.election?.id;
  const positions = read.json?.positions || [];
  ok(!!electionId && positions.length >= 1, `election + ${positions.length} positions returned`);
  const positionId = positions[0].id;

  const cands = await api(`/api/candidates?election_id=${electionId}&position_id=${positionId}`, { auth: true });
  ok(cands.status === 200 && (cands.json.candidates || []).length >= 1,
    `candidates for "${positions[0].title}" returned (${cands.json.candidates?.length})`);
  const candidateId = cands.json.candidates[0].id;

  await api("/api/state", { method: "POST", auth: true, body: { action: "reset_all_results", election_id: electionId } });

  const launch = await api("/api/state", { method: "POST", auth: true,
    body: { action: "launch", election_id: electionId, position_id: positionId, duration: 120 } });
  ok(launch.status === 200, "admin launch 200 (RBAC: org member)");

  const dbl = await api("/api/state", { method: "POST", auth: true,
    body: { action: "launch", election_id: electionId, position_id: positionId } });
  ok(dbl.status === 409, "double-launch rejected 409 (F2)");

  const checkin = await api("/api/checkin", { method: "POST",
    body: { election_id: electionId, display_name: "Test Voter", device_hash: DEVICE, pin: "1975" } });
  ok(checkin.status === 200 && checkin.json.ok, "voter check-in 200");

  const badPin = await api("/api/checkin", { method: "POST",
    body: { election_id: electionId, display_name: "X", device_hash: "b".repeat(64), pin: "0000" } });
  ok(badPin.status === 401, "wrong PIN rejected 401");

  const vote = await api("/api/vote", { method: "POST",
    body: { election_id: electionId, position_id: positionId, candidate_id: candidateId, device_hash: DEVICE } });
  ok(vote.status === 200 && vote.json.ok && !vote.json.duplicate, "first vote accepted");

  const other = cands.json.candidates[1]?.id || candidateId;
  const dupe = await api("/api/vote", { method: "POST",
    body: { election_id: electionId, position_id: positionId, candidate_id: other, device_hash: DEVICE } });
  ok(dupe.status === 200 && dupe.json.duplicate === true, "second vote returns duplicate:true (no switch)");

  const counts = await api(`/api/vote?election_id=${electionId}&position_id=${positionId}`, { auth: true });
  ok(counts.status === 200 && counts.json.total === 1 && counts.json.counts[candidateId] === 1,
    "live count = 1 for original choice");

  // RBAC: the same admin call WITHOUT a session must be rejected.
  const saved = cookie; cookie = "";
  const noauth = await api(`/api/vote?election_id=${electionId}&position_id=${positionId}`, { auth: true });
  cookie = saved;
  ok(noauth.status === 401, "admin read without session rejected 401 (RBAC)");

  const fin = await api("/api/state", { method: "POST", auth: true, body: { action: "finalize", election_id: electionId } });
  ok(fin.status === 200, "finalize 200");

  const results = await api(`/api/results?election_id=${electionId}`, { auth: true });
  const winnerRow = (results.json.winners || []).find((w) => w.position_id === positionId);
  ok(results.status === 200 && winnerRow && winnerRow.vote_count === 1,
    `results show winner with 1 vote (${winnerRow?.display})`);

  await api("/api/state", { method: "POST", auth: true, body: { action: "reset_all_results", election_id: electionId } });
  await api("/api/checkin", { method: "DELETE", auth: true, body: { election_id: electionId, device_hash: DEVICE } });

  console.log(failures === 0 ? "\nBACKEND SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
