/**
 * What the production web server needs before it serves a single request.
 *
 * next.config.js calls this when `next start` loads it, and `next start`
 * exits with these messages instead of coming up half-working. Without the
 * check, a server missing APP_DATABASE_URL served pages and returned 500 on
 * every API call, and one missing REALTIME_SECRET could not issue subscribe
 * tickets, so every page quietly fell back to polling.
 *
 * The rules match lib/db.js resolveAppDatabaseUrl() and lib/realtime.js
 * realtimeSecret() with NODE_ENV=production. Those are ES modules and
 * next.config.js is CommonJS, so they are restated here, published values
 * included; the unit test in scripts/tests checks the two agree.
 */

const { parse: parseConnectionString } = require("pg-connection-string");

const MIN_SECRET_LENGTH = 32;
// lib/db.js DEV_APP_DB_PASSWORD and lib/realtime.js PUBLISHED_REALTIME_SECRETS.
const DEV_APP_DB_PASSWORD = "app_local_dev";
const PUBLISHED_REALTIME_SECRETS = [
  "local-only-realtime-secret-replace-before-deploying",
  "local-development-realtime-secret-not-for-production",
];

/** The password pg will send, read with pg's parser; lib/db.js connectionPassword(). */
function connectionPassword(connectionString, env = process.env) {
  let password;
  try {
    password = parseConnectionString(connectionString).password;
  } catch {
    password = "";
  }
  return password || env.PGPASSWORD || "";
}

/** Returns a list of problems with `env` for production. Empty means ready. */
function productionEnvProblems(env = process.env) {
  const problems = [];
  if (!env.APP_DATABASE_URL) {
    problems.push(
      "APP_DATABASE_URL is not set. The web server connects only as the least-privilege " +
        "`app` role and never falls back to DATABASE_URL, the table owner, which bypasses " +
        "row-level security."
    );
  } else if (connectionPassword(env.APP_DATABASE_URL, env) === DEV_APP_DB_PASSWORD) {
    problems.push(
      `APP_DATABASE_URL uses the local development password (${DEV_APP_DB_PASSWORD}), which is ` +
        "published in this repository. Set a real password for the `app` role: put it in " +
        "APP_DB_PASSWORD, run db:migrate, and use the same password in APP_DATABASE_URL."
    );
  }
  const secret = env.REALTIME_SECRET;
  if (!secret) {
    problems.push(
      "REALTIME_SECRET is not set. It signs realtime subscribe tickets and must match the " +
        `gateway's. Use ${MIN_SECRET_LENGTH} or more characters, for example the output of ` +
        "`openssl rand -hex 32`."
    );
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`REALTIME_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  } else if (PUBLISHED_REALTIME_SECRETS.includes(secret)) {
    problems.push(
      "REALTIME_SECRET must not be a value published in this repository, because anyone could " +
        "use it to sign subscribe tickets and voter tags. Generate one with " +
        "`openssl rand -hex 32` and give the gateway the same value."
    );
  }
  return problems;
}

/** Throws one error listing every problem, or returns quietly. */
function assertProductionEnv(env = process.env) {
  const problems = productionEnvProblems(env);
  if (problems.length) {
    throw new Error(
      "Refusing to start the production server:\n  - " + problems.join("\n  - ")
    );
  }
}

module.exports = {
  productionEnvProblems,
  assertProductionEnv,
  MIN_SECRET_LENGTH,
  DEV_APP_DB_PASSWORD,
  PUBLISHED_REALTIME_SECRETS,
};
