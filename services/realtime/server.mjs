#!/usr/bin/env node
/**
 * Self-hosted realtime gateway.
 *
 *   node --env-file=.env.local services/realtime/server.mjs
 *   NODE_ENV=development node --env-file=.env.local services/realtime/server.mjs
 *
 * One long-lived Postgres connection LISTENs on the `election_events` channel.
 * API routes emit events with pg_notify (see lib/realtime.js) inside their
 * transaction, so a NOTIFY fires only when the change commits. Each
 * notification carries { electionId, event, data }; the gateway relays it over
 * WebSocket to every client subscribed to that election's room. The protocol
 * and the limits on anonymous clients are described in gateway.mjs.
 *
 * NOTIFY is fire-and-forget: anything sent while the LISTEN connection is down
 * is lost. So when that connection drops, clients get { type:'status',
 * live:false } and should poll; when it comes back they get live:true and a
 * 'resync' event telling them to refetch.
 *
 * Env (read by config.mjs). Only NODE_ENV=development counts as development,
 * the same rule as lib/db.js. NODE_ENV unset, "test" or anything else is
 * production, where the first three settings below are required and a signed
 * ticket is always needed to subscribe.
 *   APP_DATABASE_URL          least-privilege `app` role. The gateway never falls
 *                             back to DATABASE_URL (the owner role), which
 *                             bypasses row-level security.
 *   REALTIME_SECRET           HMAC key shared with the app for subscribe tickets
 *                             and voter tags (32+ chars)
 *   REALTIME_ALLOWED_ORIGINS  comma-separated browser origins allowed to connect,
 *                             e.g. https://vote.example.org
 *   REALTIME_PORT             default 3001
 *   REALTIME_HOST             bind address, default all interfaces
 *   REALTIME_REQUIRE_TICKET   "1" to require tickets in development too
 *   REALTIME_TRUST_PROXY      "1" when behind a reverse proxy that sets
 *                             X-Forwarded-For, so per-IP caps see real clients
 *   REALTIME_MAX_CONNECTIONS_PER_IP  default 500 (a venue's voters share one NAT IP)
 *   REALTIME_MAX_CONNECTIONS         default 20000
 *
 * For local development run it with NODE_ENV=development.
 *
 * Also serves GET /health (503 while the LISTEN connection is down).
 */
import pg from "pg";
import { assertRlsEnforced, describeDbError } from "../../lib/db.js";
import { createGateway, createListener } from "./gateway.mjs";
import { resolveGatewayConfig } from "./config.mjs";

function fail(message) {
  console.error(`[realtime] ${message}`);
  process.exit(1);
}

let config;
try {
  config = resolveGatewayConfig(process.env);
} catch (err) {
  fail(err.message);
}
for (const warning of config.warnings) console.warn(`[realtime] ${warning}`);
const { pgUrl } = config;

let listener;
const gateway = createGateway({
  allowedOrigins: config.allowedOrigins,
  requireTicket: config.requireTicket,
  secret: config.secret,
  trustProxy: config.trustProxy,
  maxConnectionsPerIp: config.maxConnectionsPerIp,
  maxConnections: config.maxConnections,
  isLive: () => Boolean(listener?.live),
});

listener = createListener({
  createClient: () =>
    new pg.Client({
      connectionString: pgUrl,
      application_name: "realtime-gateway-listen",
      // Without keepalive a silently dropped TCP connection is never noticed.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    }),
  onPayload: (payload) => gateway.handleNotify(payload),
  onLiveChange: (live, info) => {
    if (live) console.log(`[realtime] LISTEN election_events on ${pgUrl.replace(/:[^:@/]+@/, ":***@")}`);
    else console.error("[realtime] LISTEN is down; clients were told to poll");
    gateway.handleLiveChange(live, info);
  },
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([listener.stop(), gateway.close()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Refuse a role that would skip row-level security (superuser, BYPASSRLS or a
// table owner), the same check the web server runs before its first query.
try {
  const check = new pg.Client({ connectionString: pgUrl, application_name: "realtime-gateway-check" });
  await check.connect();
  try {
    await assertRlsEnforced(check);
  } finally {
    await check.end().catch(() => {});
  }
} catch (err) {
  fail(describeDbError(err, pgUrl));
}

try {
  await listener.start();
} catch (err) {
  fail(`failed to start: ${describeDbError(err, pgUrl)}`);
}
const bound = await gateway.listen(config.port, config.host).catch((err) => fail(err.message));
console.log(`[realtime] gateway on :${bound}`);
