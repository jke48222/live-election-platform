// node --test scripts/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DEV_APP_DB_PASSWORD, resolveAppDatabaseUrl } from "../../lib/db.js";
import { PUBLISHED_REALTIME_SECRETS, realtimeSecret } from "../../lib/realtime.js";

const require = createRequire(import.meta.url);
const cjs = require("../production-env.cjs");
const { productionEnvProblems, assertProductionEnv } = cjs;
const nextConfig = require("../../next.config.js");
const { PHASE_PRODUCTION_SERVER, PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } =
  require("next/constants");

const APP = "postgres://app:strong@db:5432/elections";
const OWNER = "postgres://postgres:pw@db:5432/elections";
const SECRET = "s".repeat(32);
const EXAMPLE_SECRET = "local-only-realtime-secret-replace-before-deploying";
const DEV_PASSWORD_APP = "postgres://app:app_local_dev@localhost:5432/elections";

test("a complete production environment has no problems", () => {
  assert.deepEqual(productionEnvProblems({ APP_DATABASE_URL: APP, REALTIME_SECRET: SECRET }), []);
});

test("APP_DATABASE_URL is required and DATABASE_URL does not stand in for it", () => {
  const problems = productionEnvProblems({ DATABASE_URL: OWNER, REALTIME_SECRET: SECRET });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /APP_DATABASE_URL is not set/);
});

test("REALTIME_SECRET is required", () => {
  const problems = productionEnvProblems({ APP_DATABASE_URL: APP });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /REALTIME_SECRET is not set/);
});

test("a REALTIME_SECRET shorter than 32 characters is refused", () => {
  const problems = productionEnvProblems({ APP_DATABASE_URL: APP, REALTIME_SECRET: "short" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 32 characters/);
});

test("the REALTIME_SECRET .env.example used to ship is refused", () => {
  const problems = productionEnvProblems({ APP_DATABASE_URL: APP, REALTIME_SECRET: EXAMPLE_SECRET });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /published in this repository/);
  assert.match(problems[0], /openssl rand -hex 32/);
});

test("every key published in this repository is refused", () => {
  for (const published of PUBLISHED_REALTIME_SECRETS) {
    assert.equal(productionEnvProblems({ APP_DATABASE_URL: APP, REALTIME_SECRET: published }).length, 1);
  }
});

test("an APP_DATABASE_URL with the dev password is refused", () => {
  const problems = productionEnvProblems({ APP_DATABASE_URL: DEV_PASSWORD_APP, REALTIME_SECRET: SECRET });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /development password/);
  assert.match(problems[0], /Set a real password/);
});

test("an APP_DATABASE_URL in which pg would send the dev password is refused", () => {
  for (const url of [
    "postgres://app@db/elections?password=app_local_dev",
    "postgres://app:app_local_dev@/elections?host=/cloudsql/p:r:i",
    "socket://app:app_local_dev@/var/run/postgresql?db=elections",
  ]) {
    const problems = productionEnvProblems({ APP_DATABASE_URL: url, REALTIME_SECRET: SECRET });
    assert.equal(problems.length, 1, url);
    assert.match(problems[0], /development password/);
  }
  const viaEnv = { APP_DATABASE_URL: "postgres://app@db/elections", PGPASSWORD: DEV_APP_DB_PASSWORD };
  assert.equal(productionEnvProblems({ ...viaEnv, REALTIME_SECRET: SECRET }).length, 1);
});

test("the published values are the ones the libraries refuse", () => {
  assert.equal(cjs.DEV_APP_DB_PASSWORD, DEV_APP_DB_PASSWORD);
  assert.deepEqual(cjs.PUBLISHED_REALTIME_SECRETS, PUBLISHED_REALTIME_SECRETS);
});

// .env.example is copied to .env.local. Copied as is, it must not start
// `next start`: no usable key ships in it, and its database password is the
// published development one.
test(".env.example ships no usable REALTIME_SECRET and is refused by `next start`", () => {
  const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const example = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) example[m[1]] = m[2];
  }
  assert.equal(example.REALTIME_SECRET, "");
  assert.equal(example.APP_DB_PASSWORD, DEV_APP_DB_PASSWORD);
  const problems = productionEnvProblems(example);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /development password[\s\S]*REALTIME_SECRET is not set/);
});

test("every problem is reported at once", () => {
  assert.equal(productionEnvProblems({}).length, 2);
  assert.throws(() => assertProductionEnv({}), /APP_DATABASE_URL[\s\S]*REALTIME_SECRET/);
});

// The CommonJS check restates lib/db.js and lib/realtime.js. These cases keep
// the two in step: whatever the libraries would refuse in production, the
// startup check refuses too, and the reverse.
const cases = [
  {},
  { APP_DATABASE_URL: APP },
  { REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: APP, REALTIME_SECRET: "x".repeat(31) },
  { APP_DATABASE_URL: APP, REALTIME_SECRET: SECRET },
  { DATABASE_URL: OWNER, REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: APP, REALTIME_SECRET: EXAMPLE_SECRET },
  { APP_DATABASE_URL: APP, REALTIME_SECRET: PUBLISHED_REALTIME_SECRETS[1] },
  { APP_DATABASE_URL: DEV_PASSWORD_APP, REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "postgres://app_local_dev:strong@db/app_local_dev", REALTIME_SECRET: SECRET },
  // Forms pg-connection-string reads differently from WHATWG URL.
  { APP_DATABASE_URL: "postgres://app@db/elections?password=app_local_dev", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "postgres://app:strong@db/elections?password=app_local_dev", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "postgres://app:app_local_dev@/elections?host=/cloudsql/p:r:i", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "socket://app:app_local_dev@/var/run/postgresql?db=elections", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "socket://app:strong@/var/run/postgresql?db=elections", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "postgres://app@db/elections", PGPASSWORD: "app_local_dev", REALTIME_SECRET: SECRET },
  { APP_DATABASE_URL: "postgres://app@db/elections", PGPASSWORD: "strong", REALTIME_SECRET: SECRET },
];
for (const env of cases) {
  const label = Object.entries(env).map(([k, v]) => `${k}(${v.length})`).join(", ") || "nothing set";
  test(`agrees with the libraries for ${label}`, () => {
    const prod = { ...env, NODE_ENV: "production" };
    let libOk = true;
    try {
      resolveAppDatabaseUrl(prod);
      realtimeSecret(prod);
    } catch {
      libOk = false;
    }
    assert.equal(productionEnvProblems(prod).length === 0, libOk);
  });
}

test("next.config.js runs the check only for `next start`", () => {
  const saved = { ...process.env };
  try {
    delete process.env.APP_DATABASE_URL;
    delete process.env.REALTIME_SECRET;
    assert.throws(() => nextConfig(PHASE_PRODUCTION_SERVER), /Refusing to start/);
    assert.equal(nextConfig(PHASE_PRODUCTION_BUILD).reactStrictMode, true);
    assert.equal(nextConfig(PHASE_DEVELOPMENT_SERVER).reactStrictMode, true);
    process.env.APP_DATABASE_URL = APP;
    process.env.REALTIME_SECRET = SECRET;
    assert.equal(nextConfig(PHASE_PRODUCTION_SERVER).reactStrictMode, true);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
