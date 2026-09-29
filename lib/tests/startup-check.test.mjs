// The instrumentation hook's check (lib/startup-check.js) exits a production
// server that is missing its settings, and leaves builds and development alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE = fileURLToPath(new URL("../startup-check.js", import.meta.url));
const SECRET = "s".repeat(40);

function run(env) {
  const code = `import(${JSON.stringify(MODULE)}).then((m) => m.checkProductionSettings(${JSON.stringify(env)}))`;
  const r = spawnSync(process.execPath, ["--no-warnings", "-e", code], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

test("a production server with both settings starts", () => {
  assert.equal(run({ NODE_ENV: "production", APP_DATABASE_URL: "postgres://app@db/x", REALTIME_SECRET: SECRET }).status, 0);
});

test("a production server without APP_DATABASE_URL exits, even with DATABASE_URL", () => {
  const r = run({ NODE_ENV: "production", DATABASE_URL: "postgres://owner@db/x", REALTIME_SECRET: SECRET });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /APP_DATABASE_URL is not set/);
});

test("a production server without REALTIME_SECRET, or with a short one, exits", () => {
  assert.equal(run({ NODE_ENV: "production", APP_DATABASE_URL: "postgres://app@db/x" }).status, 1);
  assert.equal(run({ NODE_ENV: "production", APP_DATABASE_URL: "postgres://app@db/x", REALTIME_SECRET: "short" }).status, 1);
});

test("a production server with the REALTIME_SECRET .env.example used to ship exits", () => {
  const r = run({
    NODE_ENV: "production",
    APP_DATABASE_URL: "postgres://app@db/x",
    REALTIME_SECRET: "local-only-realtime-secret-replace-before-deploying",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /published in this repository[\s\S]*openssl rand -hex 32/);
});

test("a production server whose APP_DATABASE_URL has the dev password exits", () => {
  const r = run({
    NODE_ENV: "production",
    APP_DATABASE_URL: "postgres://app:app_local_dev@localhost:5432/elections",
    REALTIME_SECRET: SECRET,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /development password[\s\S]*Set a real password/);
});

test("the build phase and development are not checked", () => {
  assert.equal(run({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }).status, 0);
  assert.equal(run({ NODE_ENV: "development" }).status, 0);
});
