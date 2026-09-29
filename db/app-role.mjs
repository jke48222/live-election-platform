/**
 * Decides what db/migrate.mjs does to the least-privilege `app` login role.
 * Kept free of I/O so it can be unit tested (db/tests/app-role.test.mjs).
 *
 * Rules:
 *   - APP_DB_PASSWORD set: create the role with it, or set it on the
 *     existing role. The operator asked for that password explicitly.
 *   - APP_DB_PASSWORD unset, NODE_ENV=development: create the role with the
 *     local dev password if it is missing, and leave an existing role alone.
 *   - APP_DB_PASSWORD unset anywhere else: refuse. A hard-coded password is
 *     published in this repo, so it must never reach a real database, and an
 *     existing role's password is never changed without being asked.
 *   - APP_DB_PASSWORD equal to that published password outside
 *     NODE_ENV=development: refuse, for the same reason.
 */
import { DEV_APP_DB_PASSWORD } from "../lib/db.js";

export { DEV_APP_DB_PASSWORD };

/**
 * @param {{ roleExists: boolean, env?: Record<string, string | undefined> }} input
 * @returns {{ action: "create" | "alter" | "keep", password?: string, note?: string }
 *         | { action: "error", message: string }}
 */
export function planAppRole({ roleExists, env = process.env }) {
  const password = env.APP_DB_PASSWORD;
  const isDev = env.NODE_ENV === "development";

  if (password !== undefined && password !== "") {
    if (!isDev && password === DEV_APP_DB_PASSWORD) {
      return {
        action: "error",
        message:
          `APP_DB_PASSWORD is the local development password (${DEV_APP_DB_PASSWORD}), which is ` +
          "published in this repository and must not be used outside NODE_ENV=development. " +
          "Set APP_DB_PASSWORD to a password of your own, for example the output of " +
          "`openssl rand -hex 24`, and use the same one in APP_DATABASE_URL.",
      };
    }
    return roleExists ? { action: "alter", password } : { action: "create", password };
  }

  if (!isDev) {
    return {
      action: "error",
      message:
        "APP_DB_PASSWORD is not set. Outside NODE_ENV=development the migration runner " +
        "will not guess the app role's password. Set APP_DB_PASSWORD to the password the " +
        "server uses in APP_DATABASE_URL.",
    };
  }

  if (roleExists) {
    return { action: "keep", note: "app role exists; APP_DB_PASSWORD unset, password left as is" };
  }
  return {
    action: "create",
    password: DEV_APP_DB_PASSWORD,
    note: `created app role with the local dev password (${DEV_APP_DB_PASSWORD})`,
  };
}

/** Quote a string as a Postgres literal. CREATE/ALTER ROLE cannot take bind parameters. */
export function pgLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
