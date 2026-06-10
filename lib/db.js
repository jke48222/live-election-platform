/**
 * Self-hosted Postgres data layer — replaces the Supabase SDK (lib/supabase.js).
 *
 * The app connects as the least-privilege `app` role, so Postgres RLS is
 * enforced on every tenant-data query. Tenant isolation is driven by the
 * `app.current_org` session GUC, set per-transaction by withOrg().
 *
 * Env:
 *   APP_DATABASE_URL   connection string for the `app` role (preferred)
 *   DATABASE_URL       fallback (e.g. local dev superuser)
 */
import pg from "pg";

let _pool;

/** Shared connection pool (singleton across hot reloads in dev). */
export function getPool() {
  if (_pool) return _pool;
  const connectionString =
    process.env.APP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://app:app_local_dev@localhost:5432/elections";
  _pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return _pool;
}

/**
 * Run a one-off query on a pooled connection. NOTE: this does NOT set an org
 * context, so RLS denies all tenant-data rows (fail-closed). Use it only for
 * control-plane tables (users, organizations, memberships, plans). For
 * tenant data, always go through withOrg().
 */
export async function query(text, params) {
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
