/**
 * Pure helpers shared by the voter screen, the admin console and the API
 * routes. Nothing in here touches the DOM, the network or the database, so
 * every rule can be unit tested (see poll.test.mjs).
 */

/* ── Clock ──────────────────────────────────────────────────────────────── */

/**
 * Estimate how far this device's clock is from the server's, in ms.
 * Positive means the server is ahead. The server stamped `serverNow` some time
 * between `sentAtMs` and `receivedAtMs` (local clock), so use the midpoint.
 */
export function clockOffsetMs(serverNow, sentAtMs, receivedAtMs) {
  const server = typeof serverNow === "number" ? serverNow : Date.parse(serverNow);
  if (!Number.isFinite(server) || !Number.isFinite(sentAtMs) || !Number.isFinite(receivedAtMs)) {
    return 0;
  }
  const mid = sentAtMs + Math.max(0, receivedAtMs - sentAtMs) / 2;
  return Math.round(server - mid);
}

/**
 * Where a poll stands on the server's clock.
 *   phase 'idle'   : no poll is running (waiting, completed, draft)
 *   phase 'open'   : voting, time left (remainingSec counts down)
 *   phase 'closed' : locked, or voting with the time used up
 */
export function pollPhase({ status, expiresAt, offsetMs = 0, nowMs }) {
  if (status === "locked") return { phase: "closed", remainingSec: 0 };
  if (status !== "voting") return { phase: "idle", remainingSec: null };
  const target = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(target)) return { phase: "open", remainingSec: null };
  const serverNow = nowMs + (Number.isFinite(offsetMs) ? offsetMs : 0);
  const ms = target - serverNow;
  if (ms <= 0) return { phase: "closed", remainingSec: 0 };
  return { phase: "open", remainingSec: Math.ceil(ms / 1000) };
}

/** "mm:ss" for a whole number of seconds. */
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/* ── Request ordering ───────────────────────────────────────────────────── */

/**
 * Drop stale responses. Take a token before the request, check it after:
 *
 *   const t = gate.begin();
 *   const data = await fetch(...);
 *   if (!gate.isLatest(t)) return;   // a newer request started meanwhile
 */
export function createLatestGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isLatest(token) {
      return token === current;
    },
    /** Make every in-flight request stale without starting a new one. */
    invalidate() {
      current += 1;
    },
  };
}

/* ── Election rules ─────────────────────────────────────────────────────── */

/** True when every position has been finalized (and there is at least one). */
export function allPositionsFinalized(positions) {
  return Array.isArray(positions) && positions.length > 0 && positions.every((p) => p.is_completed);
}

/** The room is idle: no live or locked poll. 'completed' counts as idle. */
export function roomIsIdle(election) {
  return (
    !!election &&
    (election.status === "waiting" || election.status === "completed") &&
    !election.active_position_id
  );
}

/** A single race can be reset only while the room is idle. */
export function canResetPosition(election) {
  return roomIsIdle(election);
}

/** The admin's final winner list should load once the room is idle and every race is done. */
export function shouldLoadFinalResults(election, positions) {
  return roomIsIdle(election) && allPositionsFinalized(positions);
}

/** Modes where check-in alone does not let a voter vote until the host verifies them. */
export function awaitingVerification(eligibilityMode, eligible) {
  return !eligible && !!eligibilityMode && eligibilityMode !== "open";
}

/**
 * Which screen a checked-in voter should see.
 * Returns 'complete' | 'pending' | 'waiting' | 'closed' | 'voted' | 'ballot'.
 */
export function voterScreen({
  status,
  hasActivePosition,
  allDone,
  eligible,
  eligibilityMode,
  phase,
  hasVoted,
}) {
  if (status === "completed" || ((status === "waiting" || !hasActivePosition) && allDone)) {
    return "complete";
  }
  if (status === "waiting" || !hasActivePosition) {
    return awaitingVerification(eligibilityMode, eligible) ? "pending" : "waiting";
  }
  // A recorded vote wins over "closed": a voter whose ballot landed in the
  // last second must see that it counted, not the same card as a non-voter.
  if (hasVoted) return "voted";
  if (status === "locked" || phase === "closed") return "closed";
  if (status === "voting" && !eligible) return "pending";
  return "ballot";
}

/**
 * The admin's vote counts must be reloaded when the live poll changes state,
 * not only when the position changes: voting -> locked (Lock Early, a
 * co-host's lock, the server's lock at the deadline), locked -> voting
 * (Clear & Restart, which sets a new deadline) and a first load.
 */
export function needsVoteRefresh(prev, next) {
  if (!next?.active_position_id) return false;
  if (next.status !== "voting" && next.status !== "locked") return false;
  if (!prev) return true;
  return (
    prev.status !== next.status ||
    prev.active_position_id !== next.active_position_id ||
    prev.poll_expires_at !== next.poll_expires_at
  );
}

/**
 * Random delay before a vote is sent, so a room of phones does not submit in
 * the same millisecond. No delay in the last 2 seconds, where it could push a
 * vote past the deadline.
 */
export const VOTE_JITTER_MAX_MS = 400;
export function voteJitterMs(remainingSec, random = Math.random()) {
  if (remainingSec != null && remainingSec <= 2) return 0;
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0;
  return Math.floor(r * VOTE_JITTER_MAX_MS);
}

/* ── Admin form rules ───────────────────────────────────────────────────── */

export const POLL_TIMER_MIN_SEC = 10;
export const POLL_TIMER_MAX_SEC = 300;

/** The poll timer field as whole seconds, or null when it is blank or out of range. */
export function parseTimerSeconds(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= POLL_TIMER_MIN_SEC && n <= POLL_TIMER_MAX_SEC ? n : null;
}

/**
 * The room PIN a host may set: 6 to 8 digits. Mirrors PIN_RE in
 * lib/eligibility.js, which is server-only and has the final say.
 */
export const HOST_PIN_MIN = 6;
export const HOST_PIN_MAX = 8;
export function isValidHostPin(pin) {
  return typeof pin === "string" && /^\d{6,8}$/.test(pin);
}

export const ELIGIBILITY_LABELS = {
  open: "Open: anyone with the link",
  pin: "Room PIN",
  roster_csv: "Roster: match a list of names",
  email_magic_link: "Email allowlist",
  access_code: "Single-use access codes",
};

/**
 * The confirmations the host must accept before the eligibility mode changes.
 * Changing the mode signs out every checked-in voter, and 'open' drops every
 * check, so it asks twice. Returns [] when nothing changes.
 */
export function eligibilityChangePrompts(fromMode, toMode, checkedInCount) {
  if (!toMode || toMode === fromMode) return [];
  const label = ELIGIBILITY_LABELS[toMode] || toMode;
  const n = Math.max(0, Number(checkedInCount) || 0);
  const first =
    n > 0
      ? `Switch to "${label}"? This signs out ${n} checked-in voter${n === 1 ? "" : "s"}. They must join again. Continue?`
      : `Switch to "${label}"? Anyone who checks in from now on uses the new method. Continue?`;
  const prompts = [first];
  if (toMode === "open") {
    prompts.push("Open mode has no PIN, list or code. Anyone with the voter link can vote. Switch to Open anyway?");
  }
  return prompts;
}

/**
 * A failed check-in that may mean the host changed the eligibility mode since
 * this page loaded, so the join form should reload the election and show the
 * fields the server now asks for.
 */
export function joinErrorNeedsElectionRefresh(status, code) {
  if (status === 401) return true;
  return ["code_required", "email_required", "invalid_code", "not_eligible"].includes(code);
}

/* ── Coalescing ─────────────────────────────────────────────────────────── */

/**
 * Collapse a burst of triggers into few runs of `run`. The first trigger
 * starts a timer; triggers before it fires are absorbed. A trigger while a run
 * is in flight marks it dirty, and one more run follows when it finishes. At
 * most one run is in flight at a time.
 */
export function createCoalescer(run, delayMs, timers = {}) {
  const setT = timers.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = timers.clearTimeout || ((id) => clearTimeout(id));
  let timer = null;
  let running = false;
  let dirty = false;
  let closed = false;

  function schedule() {
    if (timer !== null || closed) return;
    timer = setT(fire, delayMs);
  }
  async function fire() {
    timer = null;
    if (closed) return;
    running = true;
    dirty = false;
    try {
      await run();
    } catch {
      /* the next trigger retries */
    } finally {
      running = false;
      if (dirty && !closed) {
        dirty = false;
        schedule();
      }
    }
  }
  return {
    trigger() {
      if (closed) return;
      if (running) dirty = true;
      else schedule();
    },
    cancel() {
      closed = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}

/* ── Charts ─────────────────────────────────────────────────────────────── */

export const CANDIDATE_CHART_COLORS = [
  "#BA0C2F", "#1D4ED8", "#047857", "#B45309", "#7C3AED", "#BE185D",
  "#0D9488", "#CA8A04", "#4338CA", "#C2410C", "#0369A1", "#15803D",
];

/**
 * Give each candidate in one race its own color. Colors follow the order of
 * the ids, so they do not change when the display order or the counts change,
 * and two candidates share a color only when the race has more candidates
 * than the palette has colors.
 */
export function chartColorMap(candidates, palette = CANDIDATE_CHART_COLORS) {
  const ids = [...new Set((candidates || []).map((c) => String(c.id)))].sort();
  const map = {};
  ids.forEach((id, i) => {
    map[id] = palette[i % palette.length];
  });
  return map;
}

/* ── Duplicate names ────────────────────────────────────────────────────── */

/** Case- and space-insensitive key used to spot duplicate candidate names or position titles. */
export function nameKey(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
