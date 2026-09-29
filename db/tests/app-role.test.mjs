// node --test db/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_APP_DB_PASSWORD, pgLiteral, planAppRole } from "../app-role.mjs";

test("an existing role keeps its password when APP_DB_PASSWORD is unset in development", () => {
  const plan = planAppRole({ roleExists: true, env: { NODE_ENV: "development" } });
  assert.equal(plan.action, "keep");
  assert.equal(plan.password, undefined);
});

test("a missing role is created with the dev password only in development", () => {
  const plan = planAppRole({ roleExists: false, env: { NODE_ENV: "development" } });
  assert.deepEqual([plan.action, plan.password], ["create", DEV_APP_DB_PASSWORD]);
});

for (const nodeEnv of [undefined, "production", "test", ""]) {
  for (const roleExists of [true, false]) {
    test(`refuses without APP_DB_PASSWORD (NODE_ENV=${nodeEnv ?? "unset"}, role exists=${roleExists})`, () => {
      const plan = planAppRole({ roleExists, env: { NODE_ENV: nodeEnv } });
      assert.equal(plan.action, "error");
      assert.match(plan.message, /APP_DB_PASSWORD/);
    });
  }
}

test("an empty APP_DB_PASSWORD counts as unset", () => {
  const plan = planAppRole({ roleExists: true, env: { NODE_ENV: "production", APP_DB_PASSWORD: "" } });
  assert.equal(plan.action, "error");
});

test("an explicit APP_DB_PASSWORD creates or updates the role with that value", () => {
  const env = { NODE_ENV: "production", APP_DB_PASSWORD: "prod-secret-xyz" };
  assert.deepEqual(planAppRole({ roleExists: false, env }), { action: "create", password: "prod-secret-xyz" });
  assert.deepEqual(planAppRole({ roleExists: true, env }), { action: "alter", password: "prod-secret-xyz" });
});

test("no plan ever falls back to the dev password outside development", () => {
  for (const roleExists of [true, false]) {
    const plan = planAppRole({ roleExists, env: { NODE_ENV: "production" } });
    assert.notEqual(plan.password, DEV_APP_DB_PASSWORD);
  }
});

for (const nodeEnv of [undefined, "", "production", "test", "staging"]) {
  for (const roleExists of [true, false]) {
    test(`refuses the published dev password as APP_DB_PASSWORD (NODE_ENV=${nodeEnv ?? "unset"}, role exists=${roleExists})`, () => {
      const plan = planAppRole({ roleExists, env: { NODE_ENV: nodeEnv, APP_DB_PASSWORD: DEV_APP_DB_PASSWORD } });
      assert.equal(plan.action, "error");
      assert.equal(plan.password, undefined);
      assert.match(plan.message, /published/);
      assert.match(plan.message, /openssl rand/);
    });
  }
}

test("development accepts the dev password as APP_DB_PASSWORD", () => {
  const env = { NODE_ENV: "development", APP_DB_PASSWORD: DEV_APP_DB_PASSWORD };
  assert.deepEqual(planAppRole({ roleExists: false, env }), { action: "create", password: DEV_APP_DB_PASSWORD });
  assert.deepEqual(planAppRole({ roleExists: true, env }), { action: "alter", password: DEV_APP_DB_PASSWORD });
});

test("the migration runner and the app share one dev password", async () => {
  const db = await import("../../lib/db.js");
  assert.equal(DEV_APP_DB_PASSWORD, db.DEV_APP_DB_PASSWORD);
  assert.equal(db.connectionPassword(db.DEV_APP_DATABASE_URL), DEV_APP_DB_PASSWORD);
});

test("pgLiteral escapes single quotes", () => {
  assert.equal(pgLiteral("it's"), "'it''s'");
  assert.equal(pgLiteral("a'; DROP ROLE app; --"), "'a''; DROP ROLE app; --'");
});
