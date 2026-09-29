/**
 * Called from instrumentation.js in the Node.js runtime. A production server
 * without APP_DATABASE_URL or a valid REALTIME_SECRET exits here, before it
 * serves a request.
 */
import { resolveAppDatabaseUrl } from "./db.js";
import { realtimeSecret } from "./realtime.js";

export async function checkProductionSettings(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  // `next build` loads instrumentation too; only a running server needs the settings.
  if (env.NEXT_PHASE === "phase-production-build") return;
  try {
    resolveAppDatabaseUrl(env);
    realtimeSecret(env);
  } catch (err) {
    console.error(`[startup] ${err.message} Refusing to start the production server.`);
    process.exit(1);
  }
}
