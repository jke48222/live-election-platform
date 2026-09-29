/**
 * Preconditions for the election state machine (app/api/state) and for
 * ballot edits. Pure functions, so they can be unit tested.
 *
 * Two admin views of one election (a laptop and a phone, or a tab left open)
 * can act on what they last loaded. A request can therefore say which poll it
 * means, and every one it names must still match:
 *
 *   position_id      the race
 *   expires_at       the round: poll_expires_at as the page saw it. Lock
 *                    sets it to the lock time and Clear & Restart to the
 *                    runoff's end, so it tells one round of a race from the
 *                    next even though position_id stays the same.
 *   expected_status  'voting' or 'locked', as the page saw it
 *
 * Otherwise the action is refused with 409 and code "stale_state", so a stale
 * tab's auto-lock cannot close the next poll early, and a tab still showing a
 * locked tie cannot finalize or clear a runoff another tab has started.
 *
 * Finalize and Clear & Restart that name a position but no expected_status
 * expect 'locked': the console offers them only on a locked poll. A request
 * that names no position (an API script) may still finalize a voting poll.
 */

/** No poll is live or locked. 'completed' counts as idle. */
export function isIdle(election) {
  return (
    !!election &&
    ["draft", "waiting", "completed"].includes(election.status) &&
    !election.active_position_id
  );
}

function conflict(error, code) {
  return { status: 409, error, code };
}

const STALE = "The live poll changed since this page loaded. Refresh and try again.";

/**
 * Checks the optional expectations in `body` against the election. Returns a
 * 409 result when they do not match, otherwise null.
 */
export function staleExpectation(election, body = {}) {
  const expected = typeof body.position_id === "string" ? body.position_id.trim() : "";
  if (expected && expected !== election.active_position_id) return conflict(STALE, "stale_state");
  const status = typeof body.expected_status === "string" ? body.expected_status.trim() : "";
  if (status && status !== election.status) return conflict(STALE, "stale_state");
  if (typeof body.expires_at === "string" && body.expires_at) {
    const want = Date.parse(body.expires_at);
    const have = election.poll_expires_at ? new Date(election.poll_expires_at).getTime() : NaN;
    if (!Number.isFinite(want) || !Number.isFinite(have) || Math.abs(want - have) > 1000) {
      return conflict(STALE, "stale_state");
    }
  }
  return null;
}

/** A request that names a position but no status means the locked poll. */
function withLockedDefault(body = {}) {
  const names = typeof body.position_id === "string" && body.position_id.trim();
  if (!names || (typeof body.expected_status === "string" && body.expected_status.trim())) return body;
  return { ...body, expected_status: "locked" };
}

/**
 * Returns null when `action` may run on `election`, or { status, error, code }.
 * Covers lock, finalize and clear_restart; launch and the resets check their
 * own position-specific rules in the route.
 */
export function guardStateAction(action, election, body = {}) {
  const live = !!election.active_position_id;
  if (action === "lock") {
    if (election.status !== "voting" || !live) {
      return conflict("There is no live poll to lock.", "no_live_poll");
    }
    return staleExpectation(election, body);
  }
  if (action === "finalize") {
    // A room left 'locked' with no position (possible before these checks
    // existed) may be finalized to get back to 'waiting'.
    if (election.status === "locked" && !live) return null;
    if (!live || !["voting", "locked"].includes(election.status)) {
      return conflict("There is no poll to finalize.", "no_live_poll");
    }
    return staleExpectation(election, withLockedDefault(body));
  }
  if (action === "clear_restart") {
    if (!live || !["voting", "locked"].includes(election.status)) {
      return conflict("There is no poll to clear and restart.", "no_live_poll");
    }
    return staleExpectation(election, withLockedDefault(body));
  }
  return null;
}
