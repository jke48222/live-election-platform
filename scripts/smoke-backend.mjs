#!/usr/bin/env node
/**
 * End-to-end smoke test of the Supabase-free backend against a running
 * `next dev` (http://localhost:3000) with the demo data seeded.
 *
 *   npm run dev            # terminal 1
 *   npm run realtime       # terminal 2
 *   node scripts/smoke-backend.mjs
 *
 * Flow: public read → admin launch → voter check-in → vote → duplicate-vote
 * dedupe → admin live counts → finalize → results.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const ADMIN = process.env.ADMIN_PASSWORD || "testpass";
const DEVICE = "a".repeat(64);

let failures = 0;
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));

async function api(path, { method = "GET", body, admin = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers["x-admin-password"] = ADMIN;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function main() {
  // 1. Public read
  const read = await api("/api/election?org=demo&election=spring-2026");
  ok(read.status === 200, "public election read 200");
  const electionId = read.json?.election?.id;
  const positions = read.json?.positions || [];
  ok(!!electionId && positions.length >= 1, `election + ${positions.length} positions returned`);
  const positionId = positions[0].id;

  // Candidates for that position
  const cands = await api(`/api/candidates?election_id=${electionId}&position_id=${positionId}`);
  ok(cands.status === 200 && (cands.json.candidates || []).length >= 1,
    `candidates for "${positions[0].title}" returned (${cands.json.candidates?.length})`);
  const candidateId = cands.json.candidates[0].id;

  // Make sure we start clean
  await api("/api/state", { method: "POST", admin: true,
    body: { action: "reset_all_results", election_id: electionId } });

  // 2. Admin launch
  const launch = await api("/api/state", { method: "POST", admin: true,
    body: { action: "launch", election_id: electionId, position_id: positionId, duration: 120 } });
  ok(launch.status === 200, "admin launch 200");

  // Double-launch guard (F2)
  const dbl = await api("/api/state", { method: "POST", admin: true,
    body: { action: "launch", election_id: electionId, position_id: positionId } });
  ok(dbl.status === 409, "double-launch rejected 409 (F2)");

  // 3. Voter check-in (PIN mode)
  const checkin = await api("/api/checkin", { method: "POST",
    body: { election_id: electionId, display_name: "Test Voter", device_hash: DEVICE, pin: "1975" } });
  ok(checkin.status === 200 && checkin.json.ok, "voter check-in 200");

  const badPin = await api("/api/checkin", { method: "POST",
    body: { election_id: electionId, display_name: "X", device_hash: "b".repeat(64), pin: "0000" } });
  ok(badPin.status === 401, "wrong PIN rejected 401");

  // 4. Vote
  const vote = await api("/api/vote", { method: "POST",
    body: { election_id: electionId, position_id: positionId, candidate_id: candidateId, device_hash: DEVICE } });
  ok(vote.status === 200 && vote.json.ok && !vote.json.duplicate, "first vote accepted");

  // 5. Duplicate / vote-switch is sticky (integrity)
  const other = cands.json.candidates[1]?.id || candidateId;
  const dupe = await api("/api/vote", { method: "POST",
    body: { election_id: electionId, position_id: positionId, candidate_id: other, device_hash: DEVICE } });
  ok(dupe.status === 200 && dupe.json.duplicate === true, "second vote returns duplicate:true (no switch)");

  // 6. Admin live counts
  const counts = await api(`/api/vote?election_id=${electionId}&position_id=${positionId}`, { admin: true });
  ok(counts.status === 200 && counts.json.total === 1 && counts.json.counts[candidateId] === 1,
    "live count = 1 for original choice (vote-switch impossible)");

  // 7. Finalize → results
  const fin = await api("/api/state", { method: "POST", admin: true,
    body: { action: "finalize", election_id: electionId } });
  ok(fin.status === 200, "finalize 200");

  const results = await api(`/api/results?election_id=${electionId}`, { admin: true });
  const winnerRow = (results.json.winners || []).find((w) => w.position_id === positionId);
  ok(results.status === 200 && winnerRow && winnerRow.vote_count === 1,
    `results show winner with 1 vote (${winnerRow?.display})`);

  // cleanup
  await api("/api/state", { method: "POST", admin: true,
    body: { action: "reset_all_results", election_id: electionId } });
  await api("/api/checkin", { method: "DELETE", admin: true,
    body: { election_id: electionId, device_hash: DEVICE } });

  console.log(failures === 0 ? "\nBACKEND SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
