/**
 * Self-hosted Postgres data layer.
 *
 * The app connects as the least-privilege `app` role, so Postgres RLS is
 * enforced on every tenant-data query. Tenant isolation is driven by the
 * `app.current_org` session GUC, set per-transaction by withOrg().
 *
 * This module fails closed. It never falls back to DATABASE_URL (the table
 * owner, which bypasses RLS), and before the first query it checks that the
 * connected role is not a superuser, has no BYPASSRLS, and does not own any
 * RLS table. If any of those hold, every query throws.
 *
 * Env:
 *   APP_DATABASE_URL   connection string for the `app` role. Required unless
 *                      NODE_ENV=development, where it defaults to the local
 *                      dev role on localhost. Outside development it must not
 *                      use the dev password, DEV_APP_DB_PASSWORD.
 */
import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

/**
 * The `app` role's password for local development. It is published in this
 * repository (here, in .env.example and in docker-compose.yml), so the web
 * server, the gateway and db:migrate refuse it outside NODE_ENV=development.
 */
export const DEV_APP_DB_PASSWORD = "app_local_dev";
export const DEV_APP_DATABASE_URL = `postgres://app:${DEV_APP_DB_PASSWORD}@localhost:5432/elections`;

/**
 * The password pg will send for this connection string, or "" if it has none.
 * It reads the string with pg's own parser, so a `?password=` parameter, an
 * empty host (`app:pw@/elections?host=/cloudsql/...`) and `socket://` URLs
 * give the same answer pg does. Like pg, it falls back to PGPASSWORD when the
 * string carries no password.
 */
export function connectionPassword(connectionString, env = process.env) {
  let password;
  try {
    password = parseConnectionString(connectionString).password;
  } catch {
    password = "";
  }
  return password || env.PGPASSWORD || "";
}

/**
 * Pick the connection string for the app pool. Pure, so it can be tested.
 * Throws outside development when APP_DATABASE_URL is unset or uses the
 * published development password; DATABASE_URL is deliberately ignored.
 */
export function resolveAppDatabaseUrl(env = process.env) {
  if (env.APP_DATABASE_URL) {
    if (env.NODE_ENV !== "development" && connectionPassword(env.APP_DATABASE_URL, env) === DEV_APP_DB_PASSWORD) {
      throw new Error(
        `APP_DATABASE_URL uses the local development password (${DEV_APP_DB_PASSWORD}), which ` +
          "is published in this repository and must not be used outside NODE_ENV=development. " +
          "Set a real password for the `app` role: put it in APP_DB_PASSWORD, run db:migrate, " +
          "and use the same password in APP_DATABASE_URL."
      );
    }
    return env.APP_DATABASE_URL;
  }
  if (env.NODE_ENV === "development") return DEV_APP_DATABASE_URL;
  throw new Error(
    "APP_DATABASE_URL is not set. The app will not start without the least-privilege " +
      "`app` role, and it will not use DATABASE_URL, because the table owner bypasses " +
      "row-level security and would expose every organization's data to every other."
  );
}

/** Reads what the connected role can do that would skip RLS. */
export const ROLE_CHECK_SQL = `
  SELECT r.rolname,
         r.rolsuper,
         r.rolbypassrls,
         EXISTS (
           SELECT 1
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND c.relrowsecurity
              AND pg_has_role(r.oid, c.relowner, 'USAGE')
         ) AS owns_rls_table
    FROM pg_roles r
   WHERE r.rolname = current_user`;

/**
 * Returns a list of reasons the role in `row` (a ROLE_CHECK_SQL result row)
 * would bypass RLS. Empty means the role is safe for the app to use.
 */
export function roleBypassReasons(row) {
  if (!row) return ["the connected role was not found in pg_roles"];
  const reasons = [];
  if (row.rolsuper) reasons.push(`role "${row.rolname}" is a superuser`);
  if (row.rolbypassrls) reasons.push(`role "${row.rolname}" has BYPASSRLS`);
  if (row.owns_rls_table) reasons.push(`role "${row.rolname}" owns, or inherits ownership of, tables that use RLS`);
  return reasons;
}

/** Throws if the client is connected as a role that would skip RLS. */
export async function assertRlsEnforced(client) {
  const { rows } = await client.query(ROLE_CHECK_SQL);
  const reasons = roleBypassReasons(rows[0]);
  if (reasons.length) {
    const err = new Error(
      `Refusing to use this database connection: ${reasons.join("; ")}. ` +
        "Tenant isolation depends on row-level security, so APP_DATABASE_URL must " +
        "point at the least-privilege `app` role."
    );
    err.code = "RLS_BYPASS_ROLE";
    throw err;
  }
}

// Error codes that mean Postgres could not be reached at all.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** "host:port/database" from a connection string, with no user or password. */
export function describeDbTarget(connectionString) {
  try {
    const u = new URL(connectionString);
    const db = u.pathname.replace(/^\//, "");
    return `${u.hostname || "localhost"}:${u.port || "5432"}${db ? `/${db}` : ""}`;
  } catch {
    return "";
  }
}

/**
 * A one-line explanation of a database error, for scripts and the realtime
 * gateway to print before they exit. Never empty.
 *
 * Node connects to "localhost" over IPv6 and IPv4 at once, and when both are
 * refused it throws an AggregateError whose message is an empty string, with
 * the real errors in err.errors. Printing err.message alone then prints
 * nothing, so this also lists the inner errors and, when Postgres could not
 * be reached, says where it looked and what to check.
 */
export function describeDbError(err, connectionString) {
  if (err === null || err === undefined) return "unknown database error";
  if (typeof err !== "object") return String(err) || "unknown database error";

  const inner = Array.isArray(err.errors) ? err.errors : [];
  const parts = [];
  const add = (m) => {
    if (m && !parts.includes(m)) parts.push(m);
  };
  add(err.message);
  for (const e of inner) add(e?.message || e?.code || (e == null ? "" : String(e)));
  if (parts.length === 0) add(err.code || err.name || String(err));
  let text = parts.join("; ") || "unknown database error";

  const codes = [err.code, ...inner.map((e) => e?.code)];
  if (codes.some((c) => UNREACHABLE_CODES.has(c))) {
    const where = connectionString ? describeDbTarget(connectionString) : "";
    text +=
      `. Could not reach Postgres${where ? ` at ${where}` : ""}. Check that it is running ` +
      "(with Docker: docker compose up -d, then wait until docker compose ps shows it healthy) " +
      "and that the connection string points at it.";
  }
  return text;
}

let _pool;
let _roleCheck;

/** Shared connection pool (singleton across hot reloads in dev). */
export function getPool() {
  if (_pool) return _pool;
  const connectionString = resolveAppDatabaseUrl();
  _pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return _pool;
}

/**
 * Runs assertRlsEnforced once per process. A role that fails the check keeps
 * failing (fail closed); a connection error is retried on the next call.
 */
function ensureSafeRole() {
  if (!_roleCheck) {
    _roleCheck = (async () => {
      const client = await getPool().connect();
      try {
        await assertRlsEnforced(client);
      } finally {
        client.release();
      }
    })().catch((err) => {
      if (err.code !== "RLS_BYPASS_ROLE") _roleCheck = undefined;
      throw err;
    });
  }
  return _roleCheck;
}

/**
 * Run a one-off query on a pooled connection. NOTE: this does NOT set an org
 * context, so RLS denies all tenant-data rows (fail-closed). Use it only for
 * control-plane tables (users, organizations, memberships, plans). For
 * tenant data, always go through withOrg().
 */
export async function query(text, params) {
  await ensureSafeRole();
  return getPool().query(text, params);
}

/**
 * Run `fn` inside a transaction scoped to a single organization. Sets
 * `app.current_org` so RLS makes only that org's rows visible/writable, then
 * commits (or rolls back on throw).
 *
 *   const election = await withOrg(orgId, async (db) => {
 *     const { rows } = await db.query('SELECT * FROM elections WHERE slug=$1', [slug]);
 *     return rows[0];
 *   });
 *
 * `db.query` is the same node-postgres client API.
 */
export async function withOrg(orgId, fn) {
  if (!orgId) throw new Error("withOrg requires an orgId");
  await ensureSafeRole();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) => transaction-local; safe on a pooled connection.
    await client.query("SELECT set_config('app.current_org', $1, true)", [String(orgId)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Resolve an organization by slug (control-plane read; no org context needed). */
export async function getOrgBySlug(slug) {
  const { rows } = await query(
    "SELECT id, slug, name, type, branding, subscription_status FROM organizations WHERE slug = $1",
    [slug]
  );
  return rows[0] || null;
}
