/**
 * In-memory sliding-window rate limiter.
 *
 * Good enough for a single-room live election (~80 concurrent voters) where
 * the function instance is warm and long-lived under Fluid Compute. Per-instance
 * memory means multi-instance deployments can exceed the limit by Nx; that's
 * acceptable for this use case. Not durable across cold starts.
 *
 * Usage:
 *   const { ok, retryAfter } = rateLimit(`vote:${deviceHash}`, 30, 10_000);
 *   if (!ok) return 429 with Retry-After: retryAfter
 */

const WINDOWS = new Map(); // key -> number[] of recent event timestamps (ms)
const MAX_KEYS = 5000;

function sweep(now) {
  if (WINDOWS.size <= MAX_KEYS) return;
  // Drop keys with no events in the last 10 minutes
  const cutoff = now - 10 * 60 * 1000;
  for (const [k, arr] of WINDOWS) {
    if (!arr.length || arr[arr.length - 1] < cutoff) WINDOWS.delete(k);
  }
}

/**
 * @param {string} key unique identifier (route + device hash / IP)
 * @param {number} limit max events allowed in the window
 * @param {number} windowMs sliding-window size in milliseconds
 * @returns {{ ok: boolean, remaining: number, retryAfter: number }}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let arr = WINDOWS.get(key);
  if (!arr) {
    arr = [];
    WINDOWS.set(key, arr);
    sweep(now);
  }
  // Drop expired timestamps
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
    return { ok: false, remaining: 0, retryAfter };
  }
  arr.push(now);
  return { ok: true, remaining: limit - arr.length, retryAfter: 0 };
}

export function clientIpFromReq(req) {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
