// node --test db/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_APP_DATABASE_URL,
  assertRlsEnforced,
  resolveAppDatabaseUrl,
  roleBypassReasons,
} from "../../lib/db.js";

const OWNER = "postgres://owner:pw@db:5432/elections";
const APP = "postgres://app:strong@db:5432/elections";

test("uses APP_DATABASE_URL when it is set", () => {
  assert.equal(resolveAppDatabaseUrl({ APP_DATABASE_URL: APP, DATABASE_URL: OWNER }), APP);
});

for (const nodeEnv of [undefined, "production", "test"]) {
  test(`refuses to fall back to DATABASE_URL (NODE_ENV=${nodeEnv ?? "unset"})`, () => {
    assert.throws(
      () => resolveAppDatabaseUrl({ NODE_ENV: nodeEnv, DATABASE_URL: OWNER }),
      /APP_DATABASE_URL is not set/
    );
  });
}

test("development without APP_DATABASE_URL uses the local app role, never DATABASE_URL", () => {
  const url = resolveAppDatabaseUrl({ NODE_ENV: "development", DATABASE_URL: OWNER });
  assert.equal(url, DEV_APP_DATABASE_URL);
  assert.match(url, /^postgres:\/\/app:/);
});

test("roleBypassReasons flags superusers, BYPASSRLS and table owners", () => {
  const base = { rolname: "x", rolsuper: false, rolbypassrls: false, owns_rls_table: false };
  assert.deepEqual(roleBypassReasons(base), []);
  assert.equal(roleBypassReasons({ ...base, rolsuper: true }).length, 1);
  assert.equal(roleBypassReasons({ ...base, rolbypassrls: true }).length, 1);
  assert.equal(roleBypassReasons({ ...base, owns_rls_table: true }).length, 1);
  assert.equal(roleBypassReasons(undefined).length, 1);
});

test("assertRlsEnforced throws RLS_BYPASS_ROLE for an owner connection", async () => {
  const fake = (row) => ({ query: async () => ({ rows: [row] }) });
  await assert.rejects(
    assertRlsEnforced(fake({ rolname: "postgres", rolsuper: true, rolbypassrls: true, owns_rls_table: true })),
    (err) => err.code === "RLS_BYPASS_ROLE"
  );
  await assertRlsEnforced(fake({ rolname: "app", rolsuper: false, rolbypassrls: false, owns_rls_table: false }));
});
