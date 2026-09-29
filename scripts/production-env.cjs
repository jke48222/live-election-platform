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
 * next.config.js is CommonJS, so they are restated here; the unit test in
 * scripts/tests checks the two agree.
 */

const MIN_SECRET_LENGTH = 32;

/** Returns a list of problems with `env` for production. Empty means ready. */
function productionEnvProblems(env = process.env) {
  const problems = [];
  if (!env.APP_DATABASE_URL) {
    problems.push(
      "APP_DATABASE_URL is not set. The web server connects only as the least-privilege " +
        "`app` role and never falls back to DATABASE_URL, the table owner, which bypasses " +
        "row-level security."
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

module.exports = { productionEnvProblems, assertProductionEnv, MIN_SECRET_LENGTH };
