/**
 * Reads the gateway's settings from the environment. Pure, so it can be tested
 * without a database or a socket.
 *
 * The rule matches lib/db.js: only NODE_ENV=development is development.
 * Anything else, including NODE_ENV unset (plain `node server.mjs`, a bare
 * systemd unit, `npm run realtime`), "test" or "staging", is treated as
 * production. In production the gateway needs APP_DATABASE_URL,
 * REALTIME_SECRET and REALTIME_ALLOWED_ORIGINS, and it always requires a
 * signed ticket to subscribe. Missing settings throw instead of falling back
 * to development values, so a misconfigured deploy fails at startup.
 */
import { resolveAppDatabaseUrl } from "../../lib/db.js";
import { realtimeSecret } from "../../lib/realtime.js";
import { parseOrigins, DEFAULTS } from "./gateway.mjs";

export class GatewayConfigError extends Error {}

function intSetting(env, name, fallback) {
  if (!env[name]) return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 1) throw new GatewayConfigError(`${name} must be a positive integer`);
  return n;
}

/**
 * Returns { development, pgUrl, secret, allowedOrigins, requireTicket,
 * trustProxy, port, host, maxConnectionsPerIp, maxConnections, warnings }.
 * Throws GatewayConfigError when a setting is missing or invalid.
 */
export function resolveGatewayConfig(env = process.env) {
  const development = env.NODE_ENV === "development";
  const mode = development ? "development" : `production (NODE_ENV=${env.NODE_ENV || "unset"})`;
  const warnings = [];

  let pgUrl;
  try {
    pgUrl = resolveAppDatabaseUrl(env);
  } catch (err) {
    throw new GatewayConfigError(`${err.message} Refusing to start the gateway in ${mode}.`);
  }
  if (!env.APP_DATABASE_URL) warnings.push("APP_DATABASE_URL is not set; using the development default");

  if (!development && !env.REALTIME_SECRET) {
    throw new GatewayConfigError(`REALTIME_SECRET is not set. Refusing to start the gateway in ${mode}.`);
  }
  let secret;
  try {
    secret = realtimeSecret(env);
  } catch (err) {
    throw new GatewayConfigError(err.message);
  }

  const allowedOrigins = parseOrigins(env.REALTIME_ALLOWED_ORIGINS);
  if (!development && !allowedOrigins) {
    throw new GatewayConfigError(`REALTIME_ALLOWED_ORIGINS is not set. Refusing to start the gateway in ${mode}.`);
  }
  if (!allowedOrigins) warnings.push("REALTIME_ALLOWED_ORIGINS is not set; any origin may connect");

  const requireTicket = !development || env.REALTIME_REQUIRE_TICKET === "1";
  if (!requireTicket) warnings.push("subscribe tickets are not required (development)");

  return {
    development,
    pgUrl,
    secret,
    allowedOrigins,
    requireTicket,
    trustProxy: env.REALTIME_TRUST_PROXY === "1",
    port: intSetting(env, "REALTIME_PORT", 3001),
    host: env.REALTIME_HOST || undefined,
    maxConnectionsPerIp: intSetting(env, "REALTIME_MAX_CONNECTIONS_PER_IP", DEFAULTS.maxConnectionsPerIp),
    maxConnections: intSetting(env, "REALTIME_MAX_CONNECTIONS", DEFAULTS.maxConnections),
    warnings,
  };
}
