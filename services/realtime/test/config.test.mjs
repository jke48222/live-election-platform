import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGatewayConfig, GatewayConfigError } from "../config.mjs";
import { DEV_APP_DATABASE_URL } from "../../../lib/db.js";

const EXAMPLE_SECRET = "local-only-realtime-secret-replace-before-deploying";
const DEV_PASSWORD_URL = "postgres://app:app_local_dev@db.internal:5432/elections";

const APP = "postgres://app:secret@db.internal:5432/elections";
const OWNER = "postgres://postgres:postgres@db.internal:5432/elections";
const SECRET = "s".repeat(40);
const ORIGINS = "https://vote.example.org";
const FULL = { APP_DATABASE_URL: APP, REALTIME_SECRET: SECRET, REALTIME_ALLOWED_ORIGINS: ORIGINS };
const NOT_DEVELOPMENT = [undefined, "", "production", "test", "staging"];

for (const nodeEnv of NOT_DEVELOPMENT) {
  const label = `NODE_ENV=${nodeEnv === undefined ? "unset" : JSON.stringify(nodeEnv)}`;

  test(`${label}: refuses without APP_DATABASE_URL and never uses DATABASE_URL`, () => {
    assert.throws(
      () => resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, APP_DATABASE_URL: undefined, DATABASE_URL: OWNER }),
      (err) => err instanceof GatewayConfigError && /APP_DATABASE_URL is not set/.test(err.message)
    );
  });

  test(`${label}: refuses without REALTIME_SECRET`, () => {
    assert.throws(
      () => resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, REALTIME_SECRET: undefined }),
      /REALTIME_SECRET is not set/
    );
  });

  test(`${label}: refuses without REALTIME_ALLOWED_ORIGINS`, () => {
    assert.throws(
      () => resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, REALTIME_ALLOWED_ORIGINS: undefined }),
      /REALTIME_ALLOWED_ORIGINS is not set/
    );
  });

  test(`${label}: refuses the REALTIME_SECRET .env.example used to ship`, () => {
    assert.throws(
      () => resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, REALTIME_SECRET: EXAMPLE_SECRET }),
      (err) =>
        err instanceof GatewayConfigError &&
        /published in this repository/.test(err.message) &&
        /openssl rand -hex 32/.test(err.message) &&
        /Refusing to start the gateway/.test(err.message)
    );
  });

  test(`${label}: refuses an APP_DATABASE_URL with the dev password`, () => {
    assert.throws(
      () => resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, APP_DATABASE_URL: DEV_PASSWORD_URL }),
      (err) =>
        err instanceof GatewayConfigError &&
        /development password/.test(err.message) &&
        /Set a real password/.test(err.message)
    );
  });

  test(`${label}: always requires tickets, even with REALTIME_REQUIRE_TICKET=0`, () => {
    const config = resolveGatewayConfig({ ...FULL, NODE_ENV: nodeEnv, REALTIME_REQUIRE_TICKET: "0" });
    assert.equal(config.development, false);
    assert.equal(config.requireTicket, true);
    assert.equal(config.pgUrl, APP);
    assert.equal(config.secret, SECRET);
    assert.deepEqual(config.warnings, []);
  });
}

test("a short REALTIME_SECRET is refused in production", () => {
  assert.throws(() => resolveGatewayConfig({ ...FULL, REALTIME_SECRET: "short" }), /32/);
});

test("development falls back to the local app role, never to DATABASE_URL", () => {
  const config = resolveGatewayConfig({ NODE_ENV: "development", DATABASE_URL: OWNER });
  assert.equal(config.pgUrl, DEV_APP_DATABASE_URL);
  assert.equal(config.development, true);
  assert.equal(config.requireTicket, false);
  assert.equal(config.allowedOrigins, null);
  assert.ok(config.secret.length >= 32);
  assert.equal(config.warnings.length, 3);
});

test("development accepts the local example values", () => {
  const config = resolveGatewayConfig({
    NODE_ENV: "development",
    APP_DATABASE_URL: DEV_PASSWORD_URL,
    REALTIME_SECRET: EXAMPLE_SECRET,
  });
  assert.equal(config.pgUrl, DEV_PASSWORD_URL);
  assert.equal(config.secret, EXAMPLE_SECRET);
});

test("development can opt in to tickets", () => {
  const config = resolveGatewayConfig({ NODE_ENV: "development", REALTIME_REQUIRE_TICKET: "1" });
  assert.equal(config.requireTicket, true);
});

test("numeric settings are validated", () => {
  assert.equal(resolveGatewayConfig({ ...FULL, REALTIME_PORT: "4000" }).port, 4000);
  assert.equal(resolveGatewayConfig(FULL).port, 3001);
  assert.throws(() => resolveGatewayConfig({ ...FULL, REALTIME_PORT: "abc" }), /REALTIME_PORT/);
  assert.throws(() => resolveGatewayConfig({ ...FULL, REALTIME_MAX_CONNECTIONS: "0" }), /REALTIME_MAX_CONNECTIONS/);
});

// A copy of .env.example as it now ships: an empty REALTIME_SECRET and the
// dev password. Development starts; `npm run realtime` (NODE_ENV unset) does not.
test("the shipped .env.example values work in development only", () => {
  const example = {
    APP_DATABASE_URL: "postgres://app:app_local_dev@localhost:5432/elections",
    REALTIME_SECRET: "",
    REALTIME_ALLOWED_ORIGINS: "http://localhost:3000",
  };
  const config = resolveGatewayConfig({ ...example, NODE_ENV: "development" });
  assert.equal(config.pgUrl, example.APP_DATABASE_URL);
  assert.ok(config.secret.length >= 32);
  assert.throws(() => resolveGatewayConfig(example), GatewayConfigError);
});

// The entry point itself must refuse before it opens any connection, so this
// runs without a database. DATABASE_URL points at a port nothing listens on.
test("server.mjs exits 1 with NODE_ENV unset and no APP_DATABASE_URL", () => {
  const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
  const env = { PATH: process.env.PATH, DATABASE_URL: "postgres://postgres@127.0.0.1:1/elections" };
  const run = spawnSync(process.execPath, [server], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /APP_DATABASE_URL is not set/);
  assert.doesNotMatch(run.stderr + run.stdout, /development default|tickets are not required/);
});
