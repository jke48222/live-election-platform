#!/usr/bin/env node
/**
 * Phase 4 ballot-builder smoke test against a running `next dev`.
 *
 *   npm run dev · node scripts/smoke-builder.mjs
 *
 * As the demo owner: create a throwaway election, build a ballot (positions +
 * candidates), reorder, delete, and confirm structural edits are blocked while
 * a poll is live.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";

let failures = 0;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc && sc.includes("ev_session=")) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  const rnd = String(process.hrtime.bigint()).slice(-7);
  const slug = `builder-${rnd}`;

  const create = await api("/api/elections", {
    method: "POST",
    body: { org_slug: "demo", title: "Builder Test", slug, eligibility_mode: "pin", pin: "1234" },
  });
  ok(create.status === 200, "create throwaway election");
  const electionId = create.json.election.id;

  const p1 = await api("/api/positions", { method: "POST", body: { election_id: electionId, title: "President" } });
  const p2 = await api("/api/positions", { method: "POST", body: { election_id: electionId, title: "Treasurer" } });
  ok(p1.status === 200 && p2.status === 200, "added two positions");
  const presId = p1.json.position.id;
  const treasId = p2.json.position.id;

  let list = await api(`/api/positions?election_id=${electionId}`);
  ok(list.json.positions.length === 2 && list.json.positions[0].title === "President",
    "GET positions → ordered [President, Treasurer]");

  await api("/api/candidates", { method: "POST", body: { election_id: electionId, position_id: presId, name: "Ada Lovelace" } });
  await api("/api/candidates", { method: "POST", body: { election_id: electionId, position_id: presId, name: "Alan Turing" } });
  list = await api(`/api/positions?election_id=${electionId}`);
  const pres = list.json.positions.find((p) => p.id === presId);
  ok(pres.candidates.length === 2, "added two candidates to President");

  // Reorder: move Treasurer up → becomes first.
  await api("/api/positions", { method: "PATCH", body: { election_id: electionId, id: treasId, move: "up" } });
  list = await api(`/api/positions?election_id=${electionId}`);
  ok(list.json.positions[0].id === treasId, "move up reorders positions");

  // Delete a candidate.
  const candId = pres.candidates[0].id;
  await api("/api/candidates", { method: "DELETE", body: { election_id: electionId, id: candId } });
  list = await api(`/api/positions?election_id=${electionId}`);
  ok(list.json.positions.find((p) => p.id === presId).candidates.length === 1, "delete candidate");

  // Structural edits blocked while a poll is live.
  await api("/api/state", { method: "POST", body: { action: "launch", election_id: electionId, position_id: presId, duration: 60 } });
  const blocked = await api("/api/positions", { method: "POST", body: { election_id: electionId, title: "Late Add" } });
  ok(blocked.status === 409, "adding a position during live voting is rejected 409");
  await api("/api/state", { method: "POST", body: { action: "finalize", election_id: electionId } });
  await api("/api/state", { method: "POST", body: { action: "reset_all_results", election_id: electionId } });

  // Delete a position.
  const del = await api("/api/positions", { method: "DELETE", body: { election_id: electionId, id: treasId } });
  list = await api(`/api/positions?election_id=${electionId}`);
  ok(del.status === 200 && list.json.positions.length === 1, "delete position");

  console.log(failures === 0 ? "\nBUILDER SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
