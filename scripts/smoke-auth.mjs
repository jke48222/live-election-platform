#!/usr/bin/env node
/**
 * Phase 2 auth + org + RBAC smoke test against a running `next dev`.
 *
 *   npm run dev · node scripts/smoke-auth.mjs
 *
 * Signs up a fresh user, creates an org + election, and proves that:
 *   - /api/auth/me reflects the session and membership,
 *   - a different user (no membership) is denied admin actions (RBAC),
 *   - the owner is allowed.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

let failures = 0;
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));

function client() {
  let cookie = "";
  return async function api(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get("set-cookie");
    if (sc && sc.includes("ev_session=")) cookie = sc.split(";")[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

async function main() {
  const rnd = process.env.SUFFIX || String(process.hrtime.bigint()).slice(-8);
  const owner = client();
  const other = client();

  // Sign up owner
  const signup = await owner(`/api/auth/signup`, {
    method: "POST",
    body: { email: `owner_${rnd}@example.com`, password: "password123", name: "Owner" },
  });
  ok(signup.status === 200 && signup.json?.user?.id, "owner signup + auto-login");

  const me = await owner("/api/auth/me");
  ok(me.status === 200 && me.json?.user?.email === `owner_${rnd}@example.com`, "/api/auth/me reflects session");

  // Create org
  const orgSlug = `acme-${rnd}`;
  const org = await owner("/api/orgs", { method: "POST", body: { name: "Acme Club", slug: orgSlug, type: "club" } });
  ok(org.status === 200 && org.json?.org?.role === "owner", "create org → caller is owner");

  const me2 = await owner("/api/auth/me");
  ok((me2.json?.orgs || []).some((o) => o.slug === orgSlug), "org appears in owner's memberships");

  // Create election
  const elSlug = `vote-${rnd}`;
  const el = await owner("/api/elections", {
    method: "POST",
    body: { org_slug: orgSlug, title: "Board Vote", slug: elSlug, eligibility_mode: "pin", pin: "4242" },
  });
  ok(el.status === 200 && el.json?.election?.id, "owner creates an election");
  const electionId = el.json.election.id;

  // Owner CAN administer
  const ownerAct = await owner("/api/state", { method: "POST", body: { action: "reset_all_results", election_id: electionId } });
  ok(ownerAct.status === 200, "owner authorized to administer election (RBAC allow)");

  // A different signed-in user (no membership) CANNOT
  await other("/api/auth/signup", {
    method: "POST",
    body: { email: `intruder_${rnd}@example.com`, password: "password123", name: "Intruder" },
  });
  const intruderAct = await other("/api/state", { method: "POST", body: { action: "reset_all_results", election_id: electionId } });
  ok(intruderAct.status === 401, "non-member denied admin action (RBAC deny)");

  // Anonymous cannot create an org
  const anon = client();
  const anonOrg = await anon("/api/orgs", { method: "POST", body: { name: "X", slug: `x-${rnd}`, type: "club" } });
  ok(anonOrg.status === 401, "anonymous cannot create an org");

  // Duplicate email rejected
  const dup = await client()("/api/auth/signup", {
    method: "POST",
    body: { email: `owner_${rnd}@example.com`, password: "password123", name: "Dup" },
  });
  ok(dup.status === 409, "duplicate email rejected 409");

  console.log(failures === 0 ? "\nAUTH/RBAC SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
