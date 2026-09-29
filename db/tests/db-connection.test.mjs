// node --test db/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_APP_DATABASE_URL,
  DEV_APP_DB_PASSWORD,
  assertRlsEnforced,
  connectionPassword,
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

const DEV_PASSWORD_URL = `postgres://app:${DEV_APP_DB_PASSWORD}@db:5432/elections`;

for (const nodeEnv of [undefined, "", "production", "test", "staging"]) {
  test(`refuses an APP_DATABASE_URL with the dev password (NODE_ENV=${nodeEnv ?? "unset"})`, () => {
    for (const url of [DEV_PASSWORD_URL, DEV_APP_DATABASE_URL, "postgresql://app:app%5Flocal%5Fdev@db/elections"]) {
      assert.throws(
        () => resolveAppDatabaseUrl({ NODE_ENV: nodeEnv, APP_DATABASE_URL: url }),
        /development password[\s\S]*Set a real password/
      );
    }
  });
}

test("development accepts an APP_DATABASE_URL with the dev password", () => {
  assert.equal(resolveAppDatabaseUrl({ NODE_ENV: "development", APP_DATABASE_URL: DEV_PASSWORD_URL }), DEV_PASSWORD_URL);
});

test("only the password is compared, not the user or database name", () => {
  const url = "postgres://app_local_dev:strong@db:5432/app_local_dev";
  assert.equal(resolveAppDatabaseUrl({ NODE_ENV: "production", APP_DATABASE_URL: url }), url);
  assert.equal(connectionPassword(url, {}), "strong");
  assert.equal(connectionPassword("postgres://app@db/x", {}), "");
  assert.equal(connectionPassword("not a url", {}), "");
});

// pg reads connection strings with pg-connection-string, not WHATWG URL: a
// ?password= parameter wins over the userinfo, an empty host is allowed, and
// socket:// works. Each of these makes pg send the dev password.
const PG_FORMS_WITH_DEV_PASSWORD = [
  "postgres://app@db:5432/elections?password=app_local_dev",
  "postgres://app:strong@db:5432/elections?password=app_local_dev",
  "postgres://app:app_local_dev@/elections?host=localhost",
  "postgres://app:app_local_dev@/elections?host=/cloudsql/proj:region:inst",
  "socket://app:app_local_dev@/var/run/postgresql?db=elections",
];

test("reads the password the way pg does", async () => {
  const { default: ConnectionParameters } = await import("pg/lib/connection-parameters.js");
  const saved = process.env.PGPASSWORD;
  delete process.env.PGPASSWORD;
  try {
    for (const url of [...PG_FORMS_WITH_DEV_PASSWORD, APP, "postgres://app@db/x"]) {
      assert.equal(connectionPassword(url, {}), new ConnectionParameters(url).password ?? "", url);
    }
  } finally {
    if (saved !== undefined) process.env.PGPASSWORD = saved;
  }
});

test("refuses every form in which pg would send the dev password", () => {
  for (const url of PG_FORMS_WITH_DEV_PASSWORD) {
    assert.throws(
      () => resolveAppDatabaseUrl({ NODE_ENV: "production", APP_DATABASE_URL: url }),
      /development password/,
      url
    );
    assert.equal(resolveAppDatabaseUrl({ NODE_ENV: "development", APP_DATABASE_URL: url }), url);
  }
});

test("refuses the dev password through PGPASSWORD when the URL has none", () => {
  const url = "postgres://app@db:5432/elections";
  assert.throws(
    () => resolveAppDatabaseUrl({ NODE_ENV: "production", APP_DATABASE_URL: url, PGPASSWORD: DEV_APP_DB_PASSWORD }),
    /development password/
  );
  assert.equal(resolveAppDatabaseUrl({ NODE_ENV: "production", APP_DATABASE_URL: url, PGPASSWORD: "strong" }), url);
  // A password in the URL wins over PGPASSWORD, as it does in pg.
  assert.equal(resolveAppDatabaseUrl({ NODE_ENV: "production", APP_DATABASE_URL: APP, PGPASSWORD: DEV_APP_DB_PASSWORD }), APP);
});

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
