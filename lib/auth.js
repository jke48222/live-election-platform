/**
 * Self-hosted authentication — accounts, sessions, and per-org RBAC.
 * Replaces the single global ADMIN_PASSWORD with real user accounts whose
 * authority over an election comes from their membership in that election's
 * organization.
 *
 * Zero third-party deps: password hashing uses Node's built-in scrypt
 * (memory-hard, OWASP-recommended); sessions are random tokens stored hashed
 * in Postgres (revocable).
 */
import crypto from "node:crypto";
import { query } from "./db.js";

const COOKIE_NAME = "ev_session";
const SESSION_TTL_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ── Password hashing (scrypt) ── */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, hashHex] = stored.split("$");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ── Sessions ── */
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await query(
    "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [userId, hashToken(token), expires.toISOString()]
  );
  return { token, expires };
}

export async function destroySession(token) {
  if (!token) return;
  await query("DELETE FROM user_sessions WHERE token_hash = $1", [hashToken(token)]);
}

export function getSessionCookie(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const [name, ...rest] = part.split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/** Returns the authenticated user ({id,email,name,email_verified}) or null. */
export async function getSessionUser(req) {
  const token = getSessionCookie(req);
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.email_verified
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  // Best-effort last-seen bump (don't block the request on it).
  query("UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1", [
    hashToken(token),
  ]).catch(() => {});
  return rows[0];
}

/* ── RBAC ── */
export async function getMembershipRole(userId, orgId) {
  if (!userId || !orgId) return null;
  const { rows } = await query(
    "SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2",
    [userId, orgId]
  );
  return rows[0]?.role || null;
}

const ADMIN_ROLES = new Set(["owner", "admin", "staff"]);

/**
 * Authorize a request to administer a given election. Returns
 * { orgId, user, role } when the session user has an admin-capable membership
 * in the election's org, otherwise null. Resolves the org via the same
 * SECURITY DEFINER helper the routes already use.
 */
export async function authorizeElection(req, electionId) {
  const user = await getSessionUser(req);
  if (!user) return null;
  const { rows } = await query("SELECT election_org($1) AS org", [electionId]);
  const orgId = rows[0]?.org || null;
  if (!orgId) return null;
  const role = await getMembershipRole(user.id, orgId);
  if (!role || !ADMIN_ROLES.has(role)) return null;
  return { orgId, user, role };
}

/* ── Cookie headers ── */
export function sessionCookieHeader(token, expires) {
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
