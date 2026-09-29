// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { guardStateAction, isIdle, staleExpectation } from "../state-guards.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const EXP = "2026-09-29T10:00:00.000Z";

const voting = { status: "voting", active_position_id: P2, poll_expires_at: new Date(EXP) };

test("lock needs a live poll", () => {
  assert.equal(guardStateAction("lock", voting, {}), null);
  // A stale tab's lock used to strand the room in 'locked' with no position.
  const idle = guardStateAction("lock", { status: "waiting", active_position_id: null }, {});
  assert.deepEqual([idle.status, idle.code], [409, "no_live_poll"]);
  const locked = guardStateAction("lock", { status: "locked", active_position_id: P2 }, {});
  assert.equal(locked.status, 409);
});

test("lock from a tab that still shows the previous poll is refused", () => {
  const stale = guardStateAction("lock", voting, { position_id: P1 });
  assert.deepEqual([stale.status, stale.code], [409, "stale_state"]);
  assert.equal(guardStateAction("lock", voting, { position_id: P2 }), null);
});

test("lock checks the expiry the tab saw, so a restarted poll is not cut short", () => {
  assert.equal(guardStateAction("lock", voting, { position_id: P2, expires_at: EXP }), null);
  const earlier = guardStateAction("lock", voting, {
    position_id: P2,
    expires_at: "2026-09-29T09:58:00.000Z",
  });
  assert.equal(earlier.code, "stale_state");
  assert.equal(staleExpectation(voting, { expires_at: "not a date" }).code, "stale_state");
});

test("finalize needs a voting or locked poll, or recovers a stranded lock", () => {
  assert.equal(guardStateAction("finalize", voting, {}), null);
  assert.equal(guardStateAction("finalize", { ...voting, status: "locked" }, { position_id: P2 }), null);
  assert.equal(guardStateAction("finalize", { ...voting, status: "locked" }, { position_id: P1 }).code, "stale_state");
  assert.equal(guardStateAction("finalize", { status: "locked", active_position_id: null }, {}), null);
  assert.equal(guardStateAction("finalize", { status: "waiting", active_position_id: null }, {}).status, 409);
  assert.equal(guardStateAction("finalize", { status: "completed", active_position_id: null }, {}).status, 409);
});

test("clear_restart needs a poll and the right one", () => {
  assert.equal(guardStateAction("clear_restart", { ...voting, status: "locked" }, {}), null);
  assert.equal(guardStateAction("clear_restart", { status: "waiting", active_position_id: null }, {}).status, 409);
  assert.equal(guardStateAction("clear_restart", voting, { position_id: P1 }).code, "stale_state");
});

test("a tab still showing a locked tie cannot finalize or clear the runoff", () => {
  // Tab A saw the tie locked at 10:00. Tab B pressed Clear & Restart, so the
  // same race is voting again with a new end time.
  const lockedAt = "2026-09-29T10:00:00.000Z";
  const runoff = { status: "voting", active_position_id: P2, poll_expires_at: new Date("2026-09-29T10:02:00.000Z") };
  for (const action of ["finalize", "clear_restart"]) {
    // What the console sends today: only the position. It means the locked poll.
    assert.equal(guardStateAction(action, runoff, { position_id: P2 }).code, "stale_state", action);
    // With the round and status it saw.
    const full = { position_id: P2, expires_at: lockedAt, expected_status: "locked" };
    assert.equal(guardStateAction(action, runoff, full).code, "stale_state", action);
    // The runoff is locked again: status matches, the round does not.
    const relocked = { ...runoff, status: "locked", poll_expires_at: new Date("2026-09-29T10:01:30.000Z") };
    assert.equal(guardStateAction(action, relocked, full).code, "stale_state", action);
    // The tab that saw the right round goes through.
    assert.equal(guardStateAction(action, { ...relocked }, { ...full, expires_at: "2026-09-29T10:01:30.000Z" }), null);
  }
});

test("expected_status is checked for every action that names one", () => {
  assert.equal(guardStateAction("lock", voting, { position_id: P2, expected_status: "locked" }).code, "stale_state");
  assert.equal(guardStateAction("lock", voting, { position_id: P2, expected_status: "voting" }), null);
  // A script that names the position and says it means the voting poll may finalize it.
  assert.equal(guardStateAction("finalize", voting, { position_id: P2, expected_status: "voting" }), null);
  // A request that names no position keeps the old behavior.
  assert.equal(guardStateAction("finalize", voting, {}), null);
  assert.equal(guardStateAction("clear_restart", voting, {}), null);
});

test("other actions are left to the route", () => {
  assert.equal(guardStateAction("launch", { status: "waiting", active_position_id: null }, {}), null);
  assert.equal(guardStateAction("reset_all_results", voting, {}), null);
});

test("idle means no live or locked poll; completed counts", () => {
  assert.equal(isIdle({ status: "waiting", active_position_id: null }), true);
  assert.equal(isIdle({ status: "completed", active_position_id: null }), true);
  assert.equal(isIdle({ status: "draft", active_position_id: null }), true);
  assert.equal(isIdle({ status: "voting", active_position_id: P1 }), false);
  assert.equal(isIdle({ status: "locked", active_position_id: P1 }), false);
  assert.equal(isIdle({ status: "locked", active_position_id: null }), false);
  assert.equal(isIdle(null), false);
});
