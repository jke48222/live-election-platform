/**
 * Device id for the voter page.
 *
 * Each browser gets a random 256-bit id (64 hex characters) the first time it
 * opens a voter page, kept in localStorage and, as a fallback, in a cookie.
 * The id is the voter's secret for check-in and voting, so it is never shown
 * to the host or sent over realtime; the server stores only a one-way hash
 * of it (lib/voter-identity.js).
 *
 * This replaced a hardware fingerprint (canvas, audio, screen size). Two
 * phones of the same model produced the same fingerprint, so one voter's
 * check-in overwrote the other's and the second vote was dropped. Rotating
 * an Android phone or moving a window to another monitor changed it, which
 * locked voters out after a refresh.
 *
 * crypto.getRandomValues works on plain http too (unlike crypto.subtle), so
 * a phone on the same Wi-Fi can use a dev server by its LAN address.
 *
 * The function keeps its old name because the voter page imports it.
 */

const STORAGE_KEY = "ev_device_id";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // about 13 months, the browser maximum
const ID_RE = /^[0-9a-f]{64}$/;

let _cached = null;

/** 32 random bytes as lowercase hex. */
export function randomDeviceId(cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(doc) {
  try {
    const m = (doc?.cookie || "").match(/(?:^|;\s*)ev_device_id=([0-9a-f]{64})(?:;|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeCookie(doc, id) {
  try {
    if (doc) doc.cookie = `${STORAGE_KEY}=${id}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    /* cookies blocked: the id lasts for this page load only */
  }
}

/**
 * Load the stored id or create one. `env` is injectable for tests; in the
 * browser it defaults to the real localStorage, document and crypto.
 */
export function loadOrCreateDeviceId(env = {}) {
  const storage = "storage" in env ? env.storage : safeLocalStorage();
  const doc = "doc" in env ? env.doc : typeof document !== "undefined" ? document : null;
  const cryptoImpl = env.crypto || globalThis.crypto;

  let id = null;
  try {
    id = storage?.getItem(STORAGE_KEY) || null;
  } catch {
    id = null;
  }
  if (!ID_RE.test(id || "")) id = readCookie(doc);
  if (!ID_RE.test(id || "")) id = randomDeviceId(cryptoImpl);

  try {
    storage?.setItem(STORAGE_KEY, id);
  } catch {
    /* storage full or blocked: the cookie below still keeps it */
  }
  writeCookie(doc, id);
  return id;
}

function safeLocalStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The device id for this browser (async for compatibility with callers). */
export async function getDeviceHash() {
  if (!_cached) _cached = loadOrCreateDeviceId();
  return _cached;
}
