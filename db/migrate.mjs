#!/usr/bin/env node
/**
 * Zero-dependency migration runner (uses `pg`, already a runtime dep).
 *
 *   node --env-file=.env.local db/migrate.mjs
 *
 * Connects as the database owner (DATABASE_URL), makes sure the least-
 * privilege `app` login role exists, then applies every *.sql file in
 * db/migrations in lexical order exactly once, tracked in schema_migrations.
 *
 * Migrations are environment-agnostic schema. The `app` role and its
 * password are environment setup, so they live here, driven by env:
 *   APP_DB_PASSWORD   password for the `app` role. Required outside
 *                     NODE_ENV=development. When set, it is applied to the
 *                     role on every run; when unset in development, a
 *                     missing role is created with the local dev password
 *                     and an existing role is left alone. See db/app-role.mjs.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { planAppRole, pgLiteral } from "./app-role.mjs";
import { describeDbError } from "../lib/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  (process.env.NODE_ENV === "development" ? "postgres://localhost:5432/elections" : "");

async function main() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Point it at the database owner role.");
  }
  // Refuse before connecting, so a bad environment changes nothing.
  const preflight = planAppRole({ roleExists: true });
  if (preflight.action === "error") throw new Error(preflight.message);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // 1. Make sure the least-privilege app login role exists. Its password
    // is only written when the role is created or APP_DB_PASSWORD is set.
    const roleExists =
      (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'app'")).rows.length > 0;
    const plan = planAppRole({ roleExists });
    if (plan.action === "error") throw new Error(plan.message);
    if (plan.action === "create") {
      await client.query(`CREATE ROLE app LOGIN PASSWORD ${pgLiteral(plan.password)}`);
    } else if (plan.action === "alter") {
      await client.query(`ALTER ROLE app LOGIN PASSWORD ${pgLiteral(plan.password)}`);
    }
    if (plan.note) console.log(plan.note);

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
  console.error(describeDbError(err, DATABASE_URL));
  process.exit(1);
});
