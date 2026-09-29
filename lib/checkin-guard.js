/**
 * Guessing limits for voter check-in (room PINs, access codes, emails).
 *
 * Wrong answers are counted per source: per client IP when TRUSTED_PROXY_HOPS
 * lets the server know it, and per device id. A source that reaches its limit
 * is refused before its answer is checked, so it cannot keep guessing.
 *
 * Nothing keyed on the election alone ever refuses a check-in. The election
 * id is public (it comes back from the voter link), so a counter like that
 * let anyone send 100 wrong PINs and lock the whole room out, voters with the
 * right PIN included.
 *
 * The election-wide count is a signal instead. From SLOWDOWN_AT wrong
 * answers in the window, every wrong answer is returned after SLOWDOWN_MS,
 * and the host's console is told (a checkin_failures event to admin sockets)
 * so the host can rotate the PIN. The host can also clear the count. Right
 * answers are never delayed.
 *
 * Wrong emails count against their source but not toward the election
 * signal: they are mostly typos, not PIN guesses.
 *
 * Counts are per server process (lib/rate-limit.js).
 */
import {
  clearFailures,
  failureBlocked,
  failureCount,
  recordFailure,
} from "./rate-limit.js";

export const FAILURE_WINDOW_MS = 10 * 60_000;
/** Wrong answers per client IP per election per window. A room on campus
 *  Wi-Fi shares one IP, so this is well above what typos produce. */
export const IP_FAILURE_LIMIT = 50;
/** Wrong answers per device id per election per window. */
export const DEVICE_FAILURE_LIMIT = 10;
/** Election-wide wrong answers per window before failures are slowed. */
export const SLOWDOWN_AT = 100;
export const SLOWDOWN_MS = 1500;
/** After SLOWDOWN_AT, the host is told again every ALERT_EVERY failures. */
export const ALERT_EVERY = 50;

export function createCheckinGuard(store = {
  blocked: failureBlocked,
  record: recordFailure,
  count: failureCount,
  clear: clearFailures,
}) {
  const electionKey = (electionId) => `checkin-fail:${electionId}`;
  const ipKey = (electionId, ip) => `checkin-fail-ip:${electionId}:${ip}`;
  const deviceKey = (electionId, deviceId) => `checkin-fail-dev:${electionId}:${deviceId}`;

  /** { ok, retryAfter }: false when this IP or device has used up its guesses. */
  function sourceBlocked(electionId, { ip, deviceId }) {
    if (ip) {
      const r = store.blocked(ipKey(electionId, ip), IP_FAILURE_LIMIT, FAILURE_WINDOW_MS);
      if (!r.ok) return r;
    }
    if (deviceId) {
      const r = store.blocked(deviceKey(electionId, deviceId), DEVICE_FAILURE_LIMIT, FAILURE_WINDOW_MS, {
        client: true,
      });
      if (!r.ok) return r;
    }
    return { ok: true, retryAfter: 0 };
  }

  /**
   * Count one wrong answer. `guess` is false for a wrong email, which counts
   * against its source only. Returns { recent, alert }: `recent` is the
   * election-wide count, `alert` is true when the host should be told.
   */
  function recordWrongAnswer(electionId, { ip, deviceId, guess = true }) {
    if (ip) store.record(ipKey(electionId, ip), FAILURE_WINDOW_MS);
    if (deviceId) store.record(deviceKey(electionId, deviceId), FAILURE_WINDOW_MS, { client: true });
    if (!guess) return { recent: store.count(electionKey(electionId), FAILURE_WINDOW_MS), alert: false };
    store.record(electionKey(electionId), FAILURE_WINDOW_MS);
    const recent = store.count(electionKey(electionId), FAILURE_WINDOW_MS);
    const alert = recent >= SLOWDOWN_AT && (recent - SLOWDOWN_AT) % ALERT_EVERY === 0;
    return { recent, alert };
  }

  /** What the host's console shows. */
  function stats(electionId) {
    const recent = store.count(electionKey(electionId), FAILURE_WINDOW_MS);
    return {
      recent,
      window_minutes: FAILURE_WINDOW_MS / 60_000,
      slowed: recent >= SLOWDOWN_AT,
    };
  }

  /** True when wrong answers for this election are being delayed. */
  function slowed(electionId) {
    return store.count(electionKey(electionId), FAILURE_WINDOW_MS) >= SLOWDOWN_AT;
  }

  /** The host cleared the election-wide count (per-source limits stay). */
  function reset(electionId) {
    store.clear(electionKey(electionId));
  }

  return { sourceBlocked, recordWrongAnswer, stats, slowed, reset };
}

export const checkinGuard = createCheckinGuard();
