// node --test scripts/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolveAppDatabaseUrl } from "../../lib/db.js";
import { realtimeSecret } from "../../lib/realtime.js";

const require = createRequire(import.meta.url);
const { productionEnvProblems, assertProductionEnv } = require("../production-env.cjs");
const nextConfig = require("../../next.config.js");
const { PHASE_PRODUCTION_SERVER, PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } =
  require("next/constants");

const APP = "postgres://app:strong@db:5432/elections";
const OWNER = "postgres://postgres:pw@db:5432/elections";
const SECRET = "s".repeat(32);

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
