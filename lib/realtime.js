/**
 * Server-side realtime helpers. Server code only: this file uses node:crypto
 * and reads REALTIME_SECRET, so never import it from a client component.
 *
 * emit() sends an event to every client in an election's room by issuing a
 * Postgres NOTIFY that the realtime gateway (services/realtime/server.mjs)
 * relays. Pass the transaction client from withOrg() so the NOTIFY fires on
 * COMMIT and voters never see an event for a change that rolled back.
 *
 *   await withOrg(orgId, async (db) => {
 *     await db.query("UPDATE elections SET status='voting' WHERE id=$1", [electionId]);
 *     await emit(db, electionId, "state_change", { status: "voting", ... });
 *   });
 *
 * Treat every realtime payload as public. emit() enforces that:
 *   - a `device_hash` field is replaced by `voter_tag` (see voterTag()). The
 *     device hash is what /api/vote accepts, so broadcasting it would let any
 *     listener vote as that voter.
 *   - fields that are credentials or personal data (password, pin, code,
 *     token, ticket, secret, email) make emit() throw, which rolls back the
 *     caller's transaction instead of leaking them.
 *
 * Postgres NOTIFY payloads are capped at about 8000 bytes, so keep events
 * small: send a signal and ids, and let the client refetch detail.
 */
import crypto from "node:crypto";

export const NOTIFY_CHANNEL = "election_events";
const MAX_PAYLOAD = 7800;
const TICKET_VERSION = "v1";
export const TICKET_SCOPES = ["voter", "admin"];
export const DEFAULT_TICKET_TTL_SECONDS = 300;
const DEV_SECRET = "local-development-realtime-secret-not-for-production";

const FORBIDDEN_KEYS = new Set([
  "password",
  "password_hash",
  "pin",
  "code",
  "token",
  "session_token",
  "ticket",
  "secret",
  "email",
]);

/**
 * The HMAC key for voter tags and subscribe tickets. REALTIME_SECRET must be
 * set (32 or more characters) when NODE_ENV is production. Outside production
 * a fixed development key is used when it is unset, so local scripts and unit
 * tests work without one. The gateway is stricter: services/realtime/config.mjs
 * requires REALTIME_SECRET unless NODE_ENV=development, the rule lib/db.js
 * uses for APP_DATABASE_URL. The web server always runs with NODE_ENV set
 * (`next start` sets production, `next dev` sets development).
 */
export function realtimeSecret(env = process.env) {
  const s = env.REALTIME_SECRET;
  if (s) {
    if (s.length < 32) throw new Error("REALTIME_SECRET must be at least 32 characters");
    return s;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("REALTIME_SECRET must be set in production");
  }
  return DEV_SECRET;
}

function hmac(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest();
}

/**
 * A per-election tag for one voter's device. Realtime events carry this tag
 * instead of the device hash. The server hands each voter their own tag at
 * check-in, so the voter can recognise events about themselves, while a
 * listener who sees the tag cannot turn it back into the device hash.
 */
export function voterTag(electionId, deviceHash, secret = realtimeSecret()) {
  if (!electionId || !deviceHash) throw new Error("voterTag requires electionId and deviceHash");
  return hmac(secret, `voter-tag:${TICKET_VERSION}:${String(electionId)}:${String(deviceHash)}`)
    .toString("hex")
    .slice(0, 32);
}

/**
 * Returns a copy of `data` that is safe to broadcast: device_hash becomes
 * voter_tag, and credential or personal fields throw. Exported for tests.
 */
export function sanitizePayload(electionId, data, secret, depth = 0) {
  if (data === null || typeof data !== "object") return data;
  if (depth > 4) throw new Error("realtime payload is nested too deeply");
  if (Array.isArray(data)) return data.map((v) => sanitizePayload(electionId, v, secret, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const k = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(k)) {
      throw new Error(`realtime payloads are public; refusing to broadcast "${key}"`);
    }
    if (k === "device_hash") {
      if (value) out.voter_tag = voterTag(electionId, value, secret ?? realtimeSecret());
      continue;
    }
    out[key] = sanitizePayload(electionId, value, secret, depth + 1);
  }
  return out;
}

/**
 * Emit `event` to an election's room.
 *
 * options.audience: "all" (default) reaches every subscriber; "admin" reaches
 * only sockets that subscribed with an admin-scope ticket.
 */
export async function emit(client, electionId, event, data = null, { audience = "all" } = {}) {
  if (!client?.query) throw new Error("emit requires a pg client/pool");
  if (!electionId || !event) throw new Error("emit requires electionId and event");
  if (audience !== "all" && audience !== "admin") throw new Error(`unknown audience "${audience}"`);
  const id = String(electionId);
  const body = { electionId: id, event, data: sanitizePayload(id, data) };
  if (audience !== "all") body.audience = audience;
  const payload = JSON.stringify(body);
  const size = Buffer.byteLength(payload);
  if (size > MAX_PAYLOAD) throw new Error(`realtime payload too large (${size} bytes)`);
  await client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, payload]);
}

/* ── Subscribe tickets ──
 *
 * A ticket is a short-lived signed statement that lets one socket join one
 * election's room with one scope:
 *
 *   v1.<base64url {"e":electionId,"s":scope,"x":expiresAtSeconds}>.<base64url hmac>
 *
 * The app issues tickets (after check-in for voters, after an admin session
 * check for admins) and the gateway verifies them with the same
 * REALTIME_SECRET. The gateway requires one in production. A ticket is checked
 * only when a socket subscribes; an open subscription outlives its ticket.
 */
export function issueTicket(
  { electionId, scope = "voter", ttlSeconds = DEFAULT_TICKET_TTL_SECONDS, now = Date.now() },
  secret = realtimeSecret()
) {
  if (!electionId) throw new Error("issueTicket requires electionId");
  if (!TICKET_SCOPES.includes(scope)) throw new Error(`unknown ticket scope "${scope}"`);
  const ttl = Math.max(1, Math.min(Number(ttlSeconds) || DEFAULT_TICKET_TTL_SECONDS, 3600));
  const body = Buffer.from(
    JSON.stringify({ e: String(electionId).toLowerCase(), s: scope, x: Math.floor(now / 1000) + ttl })
  ).toString("base64url");
  const sig = hmac(secret, `${TICKET_VERSION}.${body}`).toString("base64url");
  return `${TICKET_VERSION}.${body}.${sig}`;
}

/** Returns { electionId, scope, expiresAt } for a valid, unexpired ticket, else null. */
export function verifyTicket(ticket, secret = realtimeSecret(), now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 1024) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) return null;
  const expected = hmac(secret, `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims.e !== "string" || !TICKET_SCOPES.includes(claims.s)) return null;
  if (typeof claims.x !== "number" || claims.x * 1000 <= now) return null;
  return { electionId: claims.e, scope: claims.s, expiresAt: claims.x * 1000 };
}
