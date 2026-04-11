/**
 * Admin session cookie helpers.
 *
 * After the admin POSTs the correct password to /api/state?action=auth, we
 * mint a short-lived HMAC token and set it as an httpOnly cookie. All admin
 * routes verify the cookie OR the legacy x-admin-password header (during the
 * transition window — can be removed once all admin UIs are updated).
 *
 * No DB session table: the token is stateless HMAC(ADMIN_PASSWORD, exp).
 */

import crypto from "node:crypto";

const COOKIE_NAME = "nsbe_admin";
const DEFAULT_TTL_SECONDS = 8 * 60 * 60; // 8 hours — long enough for a meeting

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function fromB64url(s) {
  return Buffer.from(s, "base64url");
}

function secret() {
  const pw = process.env.ADMIN_PASSWORD || "";
  // Derive a stable signing key from the admin password. Rotates if password rotates.
  return crypto.createHash("sha256").update(`nsbe-admin-v1:${pw}`).digest();
}

/** Create a signed session token valid for `ttlSeconds`. */
export function signAdminSession(ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

/** Verify a token; returns true if valid and not expired. */
export function verifyAdminToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return false;
  let payload;
  let sig;
  try {
    payload = fromB64url(payloadB64).toString("utf8");
    sig = fromB64url(sigB64);
  } catch {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest();
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(sig, expected)) return false;
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
  return true;
}

/** Read the cookie from a Next.js Request. */
export function getAdminCookie(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const [name, ...rest] = part.split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/**
 * Admin auth guard for API routes.
 * Accepts either the session cookie OR (legacy) the x-admin-password header /
 * body.password. This keeps existing admin UI paths working while the
 * dashboard migrates to cookie-based auth.
 */
export function isAdminRequest(req, body) {
  const token = getAdminCookie(req);
  if (token && verifyAdminToken(token)) return true;
  // Legacy fall-through
  const pw = body?.password || req.headers.get("x-admin-password");
  return Boolean(pw && pw === process.env.ADMIN_PASSWORD);
}

/** Cookie attribute string for Set-Cookie header. */
export function adminCookieHeader(token, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${ttlSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  // Only set Secure in production (so localhost dev still works)
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function clearAdminCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;
