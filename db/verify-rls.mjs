#!/usr/bin/env node
/**
 * Proves Postgres RLS tenant isolation end-to-end.
 *
 *   node --env-file=.env.local db/verify-rls.mjs
 *
 * As owner (DATABASE_URL) it creates two throwaway orgs A and B, each with one
 * election. Then, connected as the least-privilege `app` role, it checks:
 *   1. With app.current_org = A, only A's election is visible.
 *   2. With app.current_org = B, only B's election is visible.
 *   3. With no org context, zero tenant rows are visible (fail-closed).
 *   4. While scoped to A, inserting a row tagged org B is rejected (WITH CHECK).
 * Cleans up both orgs at the end. Exits non-zero on any failed assertion.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/elections";
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://app:app_local_dev@localhost:5432/elections";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  const app = new pg.Client({ connectionString: APP_DATABASE_URL });
  await owner.connect();
  await app.connect();

  let orgA, orgB;
  try {
    // --- setup as owner (bypasses RLS) ---
    const a = await owner.query(
      "INSERT INTO organizations (slug,name) VALUES ('rls-test-a','RLS Test A') RETURNING id");
    const b = await owner.query(
      "INSERT INTO organizations (slug,name) VALUES ('rls-test-b','RLS Test B') RETURNING id");
    orgA = a.rows[0].id;
    orgB = b.rows[0].id;
    await owner.query(
      "INSERT INTO elections (org_id,slug,title) VALUES ($1,'e','Election A')", [orgA]);
    await owner.query(
      "INSERT INTO elections (org_id,slug,title) VALUES ($1,'e','Election B')", [orgB]);
    console.log(`setup: org A=${orgA}  org B=${orgB}`);

    // --- 1 & 2: scoped reads see only own org ---
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_org',$1,true)", [orgA]);
    let r = await app.query("SELECT title FROM elections");
    assert(r.rows.length === 1 && r.rows[0].title === "Election A",
      "scoped to A: sees only Election A");
    await app.query("COMMIT");

    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_org',$1,true)", [orgB]);
    r = await app.query("SELECT title FROM elections");
    assert(r.rows.length === 1 && r.rows[0].title === "Election B",
      "scoped to B: sees only Election B");
    await app.query("COMMIT");

    // --- 3: no org context => fail closed ---
    await app.query("BEGIN");
    r = await app.query("SELECT title FROM elections");
    assert(r.rows.length === 0, "no org context: sees zero elections (fail-closed)");
    await app.query("COMMIT");

    // --- 4: cross-tenant write blocked by WITH CHECK ---
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_org',$1,true)", [orgA]);
    let blocked = false;
    try {
      await app.query(
        "INSERT INTO elections (org_id,slug,title) VALUES ($1,'x','Smuggled')", [orgB]);
    } catch {
      blocked = true;
    }
    await app.query("ROLLBACK");
    assert(blocked, "scoped to A: inserting a row tagged org B is rejected");
  } finally {
    if (orgA) await owner.query("DELETE FROM organizations WHERE id=$1", [orgA]);
    if (orgB) await owner.query("DELETE FROM organizations WHERE id=$1", [orgB]);
    await owner.end();
    await app.end();
  }

  console.log(failures === 0 ? "\nALL RLS CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
