/**
 * Runs once when a server process starts.
 *
 * next.config.js already makes `next start` refuse to start without
 * APP_DATABASE_URL and REALTIME_SECRET. A server started some other way, such
 * as the server.js of a standalone build, does not read next.config.js at
 * startup, so lib/startup-check.js repeats the check with the library
 * functions themselves.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkProductionSettings } = await import("./lib/startup-check.js");
    await checkProductionSettings();
  }
}
