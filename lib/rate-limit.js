/**
 * In-memory sliding-window rate limiter.
 *
 * Per-process memory: several server instances each keep their own counts,
 * and counts reset on restart. That is enough for a live election in one
 * room, not for a hard security boundary.
 *
 * Each limiter holds at most `maxKeys` keys. A key is dropped once its newest
 * event is older than its window. When the map is still full, keys that are
 * under their limit go first, least recently touched first, and a key that is
 * at its limit goes only when nothing else is left. The key being checked is
 * never the one dropped. So flooding the map with new keys cannot switch a
 * limit off: to push out a blocked key, an attacker would have to fill the
 * map with keys that are blocked too.
 *
 * Keys chosen by the client (device ids, emails) go in `deviceRateLimit`, a
 * separate map, so a flood of made-up device ids cannot push out the IP,
 * account and election limits kept in the default map.
 *
 *   const { ok, retryAfter } = rateLimit(`login:${ip}`, 10, 60_000);
 *   if (!ok) return 429 with Retry-After: retryAfter
 */

export function createRateLimiter({ maxKeys = 20_000, now = () => Date.now() } = {}) {
  // key -> { ts: number[] (ascending), windowMs: number, max: number }. Map
  // order is least recently touched first, because every touch re-inserts
  // the key. `max` is the limit the key was last checked against.
  const entries = new Map();

  function prune(entry, t) {
    const cutoff = t - entry.windowMs;
    let i = 0;
    while (i < entry.ts.length && entry.ts[i] <= cutoff) i++;
    if (i) entry.ts.splice(0, i);
  }

  // Evict down to 90% of the cap, so the full scan runs once per many inserts
  // rather than on every request while the map is full.
  const target = Math.max(1, Math.floor(maxKeys * 0.9));

  function evict(t, keep) {
    if (entries.size <= maxKeys) return;
    // Pass 1: drop keys with no events left in their window.
    for (const [k, e] of entries) {
      if (k === keep) continue;
      const last = e.ts[e.ts.length - 1];
      if (last === undefined || last <= t - e.windowMs) entries.delete(k);
    }
    // Pass 2: drop keys under their limit, least recently touched first.
    for (const [k, e] of entries) {
      if (entries.size <= target) break;
      if (k !== keep && e.ts.length < e.max) entries.delete(k);
    }
    // Pass 3: only blocked keys are left; drop the least recently touched.
    for (const k of entries.keys()) {
      if (entries.size <= target) break;
      if (k !== keep) entries.delete(k);
    }
  }

  function touch(key, windowMs, t, max) {
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entry.windowMs = Math.max(entry.windowMs, windowMs);
      if (max !== undefined) entry.max = max;
    } else {
      entry = { ts: [], windowMs, max: max ?? Infinity };
    }
    entries.set(key, entry);
    prune(entry, t);
    if (entries.size > maxKeys) evict(t, key);
    return entry;
  }

  function retryAfter(entry, windowMs, t) {
    return Math.max(1, Math.ceil((entry.ts[0] + windowMs - t) / 1000));
  }

  /** Count one event for `key` if it is under `max` within `windowMs`. */
  function limit(key, max, windowMs) {
    const t = now();
    const entry = touch(key, windowMs, t, max);
    if (entry.ts.length >= max) {
      return { ok: false, remaining: 0, retryAfter: retryAfter(entry, windowMs, t) };
    }
    entry.ts.push(t);
    return { ok: true, remaining: max - entry.ts.length, retryAfter: 0 };
  }

  /** Check `key` against `max` without counting an event. */
  function peek(key, max, windowMs) {
    const t = now();
    const entry = entries.get(key);
    if (!entry) return { ok: true, remaining: max, retryAfter: 0 };
    entry.max = max;
    prune(entry, t);
    if (entry.ts.length >= max) {
      return { ok: false, remaining: 0, retryAfter: retryAfter(entry, windowMs, t) };
    }
    return { ok: true, remaining: max - entry.ts.length, retryAfter: 0 };
  }

  /** Count one event for `key` without checking a limit (for failure counters). */
  function record(key, windowMs) {
    const t = now();
    touch(key, windowMs, t).ts.push(t);
  }

  /** Events for `key` still inside `windowMs`. */
  function count(key, windowMs) {
    const entry = entries.get(key);
    if (!entry) return 0;
    const t = now();
    prune(entry, t);
    return entry.ts.filter((ts) => ts > t - windowMs).length;
  }

  /** Forget `key` (a host cleared a failure counter). */
  function clear(key) {
    entries.delete(key);
  }

  return {
    limit,
    peek,
    record,
    count,
    clear,
    size: () => entries.size,
    has: (k) => entries.has(k),
  };
}

const defaultLimiter = createRateLimiter({ maxKeys: 20_000 });
const deviceLimiter = createRateLimiter({ maxKeys: 50_000 });

/**
 * @param {string} key unique identifier (route + IP / account / election)
 * @param {number} limit max events allowed in the window
 * @param {number} windowMs sliding-window size in milliseconds
 * @returns {{ ok: boolean, remaining: number, retryAfter: number }}
 */
export function rateLimit(key, limit, windowMs) {
  return defaultLimiter.limit(key, limit, windowMs);
}

/** Same as rateLimit, for keys the client picks (device ids, emails). */
export function deviceRateLimit(key, limit, windowMs) {
  return deviceLimiter.limit(key, limit, windowMs);
}

/**
 * Failure counters. failureBlocked() reports whether `key` has reached
 * `limit` failures within `windowMs`; recordFailure() adds one. Pass
 * { client: true } for keys the client picks (device ids), so they live in
 * the device map like deviceRateLimit keys.
 *
 * Key a blocking counter on the source of the guesses (an IP, a device, an
 * account plus an IP), never on the target alone. A counter keyed only on an
 * election or an account lets anyone who sends enough wrong guesses lock out
 * everyone else, including people who know the right answer.
 */
export function failureBlocked(key, limit, windowMs, { client = false } = {}) {
  return (client ? deviceLimiter : defaultLimiter).peek(key, limit, windowMs);
}

export function recordFailure(key, windowMs, { client = false } = {}) {
  (client ? deviceLimiter : defaultLimiter).record(key, windowMs);
}

/** Failures recorded for `key` within `windowMs` (for signals, not blocks). */
export function failureCount(key, windowMs) {
  return defaultLimiter.count(key, windowMs);
}

/** Drop a failure counter. */
export function clearFailures(key) {
  defaultLimiter.clear(key);
}

/**
 * The client's IP address, or null when it cannot be known.
 *
 * X-Forwarded-For is written by the client unless a proxy in front of the app
 * appends to it, so it is trusted only when TRUSTED_PROXY_HOPS says how many
 * proxies append to it. With N hops, the client address is the Nth entry from
 * the right; everything to its left came from the client and is ignored.
 * Without TRUSTED_PROXY_HOPS this returns null and callers skip per-IP limits,
 * because Next.js route handlers do not expose the socket address.
 */
export function clientIpFromReq(req, env = process.env) {
  const hops = Number.parseInt(env.TRUSTED_PROXY_HOPS ?? "", 10);
  if (!Number.isInteger(hops) || hops < 1) return null;
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const parts = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < hops) return null;
  return parts[parts.length - hops] || null;
}
