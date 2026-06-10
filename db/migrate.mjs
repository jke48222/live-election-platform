#!/usr/bin/env node
/**
 * Zero-dependency migration runner (uses `pg`, already a runtime dep).
 *
 *   node --env-file=.env.local db/migrate.mjs
 *
 * Connects as a superuser/owner (DATABASE_URL), ensures the least-
 * privilege `app` login role exists, then applies every *.sql file in
 * db/migrations in lexical order exactly once, tracked in schema_migrations.
 *
 * Migrations are environment-agnostic schema; the `app` role + its
 * password are environment setup, so they live here, driven by env:
 *   APP_DB_PASSWORD   password to assign the `app` role (default for local dev)
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/elections";
const APP_DB_PASSWORD = process.env.APP_DB_PASSWORD || "app_local_dev";

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 1. Ensure the least-privilege app login role exists.
    // CREATE/ALTER ROLE are utility statements — they can't take bind
    // parameters, so the password is inlined as a safely-escaped literal.
    const pwLiteral = "'" + String(APP_DB_PASSWORD).replace(/'/g, "''") + "'";
    const roleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'app'");
    if (roleExists.rows.length === 0) {
      await client.query(`CREATE ROLE app LOGIN PASSWORD ${pwLiteral}`);
    } else {
      await client.query(`ALTER ROLE app LOGIN PASSWORD ${pwLiteral}`);
    }

    // 2. Migration bookkeeping table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`→ applying ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log("ok");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }
    console.log(count === 0 ? "Already up to date." : `Applied ${count} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
