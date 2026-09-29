/**
 * Password-guessing limits for /api/auth/login.
 *
 * A lockout keyed on the account alone lets anyone who knows the host's email
 * send ten wrong passwords and keep the host out of /admin. So wrong
 * passwords are counted per source, and the account-wide count only blocks
 * where no source can be told apart:
 *
 *   - A browser that has signed in to this account before carries a signed
 *     "known device" cookie. Strangers' failures never block it; only its own
 *     do (KNOWN_DEVICE_FAILURES).
 *   - With a client IP (TRUSTED_PROXY_HOPS set), each IP gets
 *     SOURCE_FAILURES per account, and the account-wide ceiling is
 *     ACCOUNT_CEILING, which takes many IPs to reach.
 *   - With no IP, the account-wide count blocks at SOURCE_FAILURES. That is
 *     the only brute-force limit left, so it stays, and a host who has signed
 *     in from this browser before still gets in.
 *
 * The cookie is an HMAC over the email and a random nonce, keyed with the
 * server's REALTIME_SECRET (lib/realtime.js) under its own prefix. It is not
 * a session and grants nothing but exemption from other people's failures.
 */
import crypto from "node:crypto";

export const KNOWN_DEVICE_COOKIE = "ev_known";
export const KNOWN_DEVICE_DAYS = 180;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const SOURCE_FAILURES = 10;
export const KNOWN_DEVICE_FAILURES = 10;
export const ACCOUNT_CEILING = 100;

function sign(secret, email, nonce) {
  return crypto
    .createHmac("sha256", secret)
    .update(`login-known-device:v1:${email}:${nonce}`)
    .digest("hex");
}

/** A new known-device cookie value for `email`. */
export function knownDeviceValue(email, secret) {
  const nonce = crypto.randomBytes(16).toString("hex");
  return `${nonce}.${sign(secret, email, nonce)}`;
}

/** Set-Cookie header for a known-device cookie, scoped to the login route. */
export function knownDeviceCookieHeader(value, { secure = false } = {}) {
  const attrs = [
    `${KNOWN_DEVICE_COOKIE}=${value}`,
    "Path=/api/auth/login",
    `Max-Age=${KNOWN_DEVICE_DAYS * 86400}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * The nonce of a valid known-device cookie for `email` on this request, or
 * null. Constant-time comparison of the signature.
 */
export function knownDeviceNonce(req, email, secret) {
  if (!secret || !email) return null;
  const raw = req.headers.get("cookie") || "";
  let value = null;
  for (const part of raw.split(/;\s*/)) {
    const [name, ...rest] = part.split("=");
    if (name === KNOWN_DEVICE_COOKIE) value = rest.join("=");
  }
  const m = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(value || "");
  if (!m) return null;
  const want = Buffer.from(sign(secret, email, m[1]), "hex");
  const got = Buffer.from(m[2], "hex");
  return crypto.timingSafeEqual(want, got) ? m[1] : null;
}

/**
 * Which counters apply to one login attempt. Returns { burst, checks,
 * records }. `burst` is the key for the attempts-per-minute limit. Every
 * check is { key, limit } and must be under its limit before the password is
 * checked; a wrong password adds one to every key in `records`.
 */
export function loginFailurePlan({ email, ip, knownNonce }) {
  const account = `login-fail:${email}`;
  if (knownNonce) {
    const own = `login-fail-known:${email}:${knownNonce}`;
    return {
      burst: `login-burst-known:${email}:${knownNonce}`,
      checks: [{ key: own, limit: KNOWN_DEVICE_FAILURES }],
      records: [own, account],
    };
  }
  if (ip) {
    const source = `login-fail-ip:${ip}:${email}`;
    return {
      burst: `login-burst:${ip}:${email}`,
      checks: [
        { key: source, limit: SOURCE_FAILURES },
        { key: account, limit: ACCOUNT_CEILING },
      ],
      records: [source, account],
    };
  }
  return {
    burst: `login-burst:${email}`,
    checks: [{ key: account, limit: SOURCE_FAILURES }],
    records: [account],
  };
}
