#!/usr/bin/env node
/**
 * Phase 5 eligibility-provider smoke test against a running `next dev`.
 *
 *   npm run dev · node scripts/smoke-eligibility.mjs
 *
 * Covers roster_csv (match → verified, miss → pending), email_magic_link
 * (allowlist accept/reject), and access_code (valid → verified, reuse on a new
 * device → rejected, bad code → rejected). Admin ops use the demo owner
 * session; check-ins are anonymous.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";
const dev = (ch) => ch.repeat(64);

let failures = 0;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (sc && sc.includes("ev_session=")) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const checkin = (b) => api("/api/checkin", { method: "POST", body: b });
const setMode = (id, mode) => api("/api/elections", { method: "PATCH", auth: true, body: { election_id: id, eligibility_mode: mode } });

async function main() {
  await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  const rnd = String(process.hrtime.bigint()).slice(-7);
  const create = await api("/api/elections", {
    method: "POST",
    auth: true,
    body: { org_slug: "demo", title: "Eligibility Test", slug: `elig-${rnd}`, eligibility_mode: "pin", pin: "1111" },
  });
  ok(create.status === 200, "create test election");
  const id = create.json.election.id;

  // ── roster_csv ──
  await setMode(id, "roster_csv");
  await api("/api/roster", { method: "POST", auth: true, body: { election_id: id, text: "Ada Lovelace\nAlan Turing" } });
  const r1 = await checkin({ election_id: id, display_name: "Ada Lovelace", device_hash: dev("a") });
  ok(r1.status === 200 && r1.json.verified === true, "roster: matching name → auto-verified");
  const r2 = await checkin({ election_id: id, display_name: "Bob Stranger", device_hash: dev("b") });
  ok(r2.status === 200 && r2.json.verified === false, "roster: unknown name → checked in but pending");

  // ── email_magic_link ──
  await setMode(id, "email_magic_link");
  await api("/api/roster", { method: "POST", auth: true, body: { election_id: id, text: "ada@example.com" } });
  const e1 = await checkin({ election_id: id, display_name: "Ada", email: "ada@example.com", device_hash: dev("c") });
  ok(e1.status === 200 && e1.json.verified === true, "email: allowlisted email → verified");
  const e2 = await checkin({ election_id: id, display_name: "Nobody", email: "nobody@example.com", device_hash: dev("d") });
  ok(e2.status === 403 && e2.json.code === "not_eligible", "email: non-listed email → rejected 403");

  // ── access_code ──
  await setMode(id, "access_code");
  const gen = await api("/api/roster", { method: "POST", auth: true, body: { election_id: id, generate_codes: 2 } });
  ok(gen.status === 200 && (gen.json.codes || []).length === 2, "access_code: generated 2 codes");
  const code = gen.json.codes[0];
  const a1 = await checkin({ election_id: id, display_name: "Voter One", code, device_hash: dev("e") });
  ok(a1.status === 200 && a1.json.verified === true, "access_code: valid code → verified");
  const a2 = await checkin({ election_id: id, display_name: "Voter One", code, device_hash: dev("e") });
  ok(a2.status === 200 && a2.json.verified === true, "access_code: same device re-check-in allowed");
  const a3 = await checkin({ election_id: id, display_name: "Imposter", code, device_hash: dev("f") });
  ok(a3.status === 403 && a3.json.code === "code_used", "access_code: reuse on a new device → rejected");
  const a4 = await checkin({ election_id: id, display_name: "Guesser", code: "ZZZ999", device_hash: dev("0") });
  ok(a4.status === 403 && a4.json.code === "invalid_code", "access_code: invalid code → rejected");

  console.log(failures === 0 ? "\nELIGIBILITY SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
