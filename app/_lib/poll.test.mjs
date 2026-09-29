// Unit tests for app/_lib/poll.js. Run with: node --test app/_lib/
import test from "node:test";
import assert from "node:assert/strict";
import {
  clockOffsetMs,
  pollPhase,
  formatClock,
  createLatestGate,
  canResetPosition,
  shouldLoadFinalResults,
  awaitingVerification,
  voterScreen,
  chartColorMap,
  CANDIDATE_CHART_COLORS,
  nameKey,
  needsVoteRefresh,
  voteJitterMs,
  parseTimerSeconds,
  eligibilityChangePrompts,
  joinErrorNeedsElectionRefresh,
  createCoalescer,
  isValidHostPin,
} from "./poll.js";

const T0 = Date.parse("2026-09-29T18:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("clockOffsetMs uses the midpoint of the round trip", () => {
  // Server stamped T0 + 30 s; request left at T0, came back at T0 + 200 ms.
  assert.equal(clockOffsetMs(iso(T0 + 30_000), T0, T0 + 200), 29_900);
  // Device 20 s fast: server is behind.
  assert.equal(clockOffsetMs(iso(T0), T0 + 20_000, T0 + 20_000), -20_000);
  assert.equal(clockOffsetMs("not a date", T0, T0), 0);
  assert.equal(clockOffsetMs(undefined, T0, T0), 0);
});

test("pollPhase: idle and locked states", () => {
  assert.deepEqual(pollPhase({ status: "waiting", expiresAt: null, nowMs: T0 }), { phase: "idle", remainingSec: null });
  assert.deepEqual(pollPhase({ status: "completed", expiresAt: null, nowMs: T0 }), { phase: "idle", remainingSec: null });
  assert.deepEqual(pollPhase({ status: "locked", expiresAt: iso(T0 + 60_000), nowMs: T0 }), { phase: "closed", remainingSec: 0 });
});

test("pollPhase counts down on the server's clock", () => {
  const expiresAt = iso(T0 + 60_000);
  assert.deepEqual(pollPhase({ status: "voting", expiresAt, offsetMs: 0, nowMs: T0 }), { phase: "open", remainingSec: 60 });
  assert.deepEqual(pollPhase({ status: "voting", expiresAt, offsetMs: 0, nowMs: T0 + 59_001 }), { phase: "open", remainingSec: 1 });
  assert.deepEqual(pollPhase({ status: "voting", expiresAt, offsetMs: 0, nowMs: T0 + 60_000 }), { phase: "closed", remainingSec: 0 });
});

test("pollPhase: a device clock 30 s fast does not close a 60 s poll early", () => {
  const expiresAt = iso(T0 + 60_000);
  const deviceNow = T0 + 30_000 + 30_000; // 30 s after launch, clock 30 s fast
  const offsetMs = -30_000;
  const naive = pollPhase({ status: "voting", expiresAt, offsetMs: 0, nowMs: deviceNow });
  assert.equal(naive.phase, "closed", "without the offset the poll looks closed");
  const fixed = pollPhase({ status: "voting", expiresAt, offsetMs, nowMs: deviceNow });
  assert.deepEqual(fixed, { phase: "open", remainingSec: 30 });
});

test("pollPhase: a device clock 20 s slow still sees the poll close on time", () => {
  const expiresAt = iso(T0 + 60_000);
  const deviceNow = T0 + 60_000 - 20_000; // server time is exactly the expiry
  assert.equal(pollPhase({ status: "voting", expiresAt, offsetMs: 0, nowMs: deviceNow }).phase, "open");
  assert.equal(pollPhase({ status: "voting", expiresAt, offsetMs: 20_000, nowMs: deviceNow }).phase, "closed");
});

test("pollPhase: voting without an expiry stays open", () => {
  assert.deepEqual(pollPhase({ status: "voting", expiresAt: null, nowMs: T0 }), { phase: "open", remainingSec: null });
});

test("formatClock", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(61), "01:01");
  assert.equal(formatClock(-5), "00:00");
});

test("createLatestGate drops responses that arrive out of order", async () => {
  const gate = createLatestGate();
  const applied = [];
  const request = (value, delay) => {
    const t = gate.begin();
    return new Promise((r) => setTimeout(r, delay)).then(() => {
      if (gate.isLatest(t)) applied.push(value);
    });
  };
  // R1 ('waiting') starts first but lands last; R2 ('voting') must win.
  await Promise.all([request("waiting", 30), request("voting", 5)]);
  assert.deepEqual(applied, ["voting"]);
});

test("createLatestGate.invalidate makes in-flight requests stale", () => {
  const gate = createLatestGate();
  const t = gate.begin();
  gate.invalidate();
  assert.equal(gate.isLatest(t), false);
});

test("canResetPosition allows waiting and completed rooms with no poll", () => {
  assert.equal(canResetPosition({ status: "waiting", active_position_id: null }), true);
  assert.equal(canResetPosition({ status: "completed", active_position_id: null }), true);
  assert.equal(canResetPosition({ status: "voting", active_position_id: "p1" }), false);
  assert.equal(canResetPosition({ status: "locked", active_position_id: "p1" }), false);
  assert.equal(canResetPosition({ status: "waiting", active_position_id: "p1" }), false);
  assert.equal(canResetPosition(null), false);
});

test("shouldLoadFinalResults fires once the election is completed", () => {
  const done = [{ is_completed: true }, { is_completed: true }];
  assert.equal(shouldLoadFinalResults({ status: "completed", active_position_id: null }, done), true);
  assert.equal(shouldLoadFinalResults({ status: "waiting", active_position_id: null }, done), true);
  assert.equal(shouldLoadFinalResults({ status: "completed", active_position_id: null }, [{ is_completed: false }]), false);
  assert.equal(shouldLoadFinalResults({ status: "completed", active_position_id: null }, []), false);
  assert.equal(shouldLoadFinalResults({ status: "locked", active_position_id: "p" }, done), false);
});

test("awaitingVerification", () => {
  assert.equal(awaitingVerification("roster_csv", false), true);
  assert.equal(awaitingVerification("roster_csv", true), false);
  assert.equal(awaitingVerification("open", false), false);
  assert.equal(awaitingVerification(undefined, false), false);
});

test("voterScreen: unverified roster voter sees the pending screen while the room waits", () => {
  const base = { status: "waiting", hasActivePosition: false, allDone: false, phase: "idle", hasVoted: false };
  assert.equal(voterScreen({ ...base, eligible: false, eligibilityMode: "roster_csv" }), "pending");
  assert.equal(voterScreen({ ...base, eligible: true, eligibilityMode: "roster_csv" }), "waiting");
  assert.equal(voterScreen({ ...base, eligible: false, eligibilityMode: "open" }), "waiting");
});

test("voterScreen: the other states", () => {
  const live = { status: "voting", hasActivePosition: true, allDone: false, eligible: true, eligibilityMode: "pin", phase: "open", hasVoted: false };
  assert.equal(voterScreen(live), "ballot");
  assert.equal(voterScreen({ ...live, hasVoted: true }), "voted");
  assert.equal(voterScreen({ ...live, phase: "closed" }), "closed");
  assert.equal(voterScreen({ ...live, status: "locked", phase: "closed" }), "closed");
  assert.equal(voterScreen({ ...live, eligible: false }), "pending");
  assert.equal(voterScreen({ ...live, status: "completed", hasActivePosition: false, allDone: true }), "complete");
  assert.equal(voterScreen({ ...live, status: "waiting", hasActivePosition: false, allDone: true }), "complete");
});

test("chartColorMap gives every candidate in a race its own color", () => {
  // Ids that the old per-id hash mapped to the same color are fine now.
  for (let n = 1; n <= CANDIDATE_CHART_COLORS.length; n++) {
    const cands = Array.from({ length: n }, (_, i) => ({ id: `id-${(i * 7919) % 1000}-${i}` }));
    const colors = Object.values(chartColorMap(cands));
    assert.equal(new Set(colors).size, n, `${n} candidates, ${new Set(colors).size} colors`);
  }
});

test("chartColorMap does not depend on the order candidates are passed in", () => {
  const a = [{ id: "c" }, { id: "a" }, { id: "b" }];
  const b = [{ id: "b" }, { id: "c" }, { id: "a" }];
  assert.deepEqual(chartColorMap(a), chartColorMap(b));
});

test("nameKey ignores case and extra spaces", () => {
  assert.equal(nameKey("  Jordan   Blake "), nameKey("jordan blake"));
  assert.notEqual(nameKey("Jordan Blake"), nameKey("Jordan Blakes"));
});

test("voterScreen: a vote recorded in the last second shows 'voted', not 'closed'", () => {
  const live = { status: "voting", hasActivePosition: true, allDone: false, eligible: true, eligibilityMode: "pin", phase: "open", hasVoted: true };
  assert.equal(voterScreen({ ...live, phase: "closed" }), "voted");
  assert.equal(voterScreen({ ...live, status: "locked", phase: "closed" }), "voted");
  assert.equal(voterScreen({ ...live, hasVoted: false, status: "locked", phase: "closed" }), "closed");
});

test("voteJitterMs skips the delay in the last 2 seconds", () => {
  assert.equal(voteJitterMs(2, 0.99), 0);
  assert.equal(voteJitterMs(1, 0.5), 0);
  assert.equal(voteJitterMs(0, 0.5), 0);
  assert.equal(voteJitterMs(3, 0.5), 200);
  assert.equal(voteJitterMs(null, 0.5), 200, "a poll with no deadline still spreads submits");
  assert.ok(voteJitterMs(60, 1) <= 400);
  assert.equal(voteJitterMs(60, NaN), 0);
});

test("needsVoteRefresh: voting to locked (Lock Early, co-host, server lock)", () => {
  const voting = { status: "voting", active_position_id: "p1", poll_expires_at: "2026-09-29T18:01:00Z" };
  const locked = { ...voting, status: "locked", poll_expires_at: "2026-09-29T18:00:40Z" };
  assert.equal(needsVoteRefresh(voting, locked), true);
  // A co-host's lock that leaves the deadline as it was still refreshes.
  assert.equal(needsVoteRefresh(voting, { ...voting, status: "locked" }), true);
});

test("needsVoteRefresh: locked to voting (Clear & Restart) and first load", () => {
  const locked = { status: "locked", active_position_id: "p1", poll_expires_at: "2026-09-29T18:00:40Z" };
  const restarted = { status: "voting", active_position_id: "p1", poll_expires_at: "2026-09-29T18:02:00Z" };
  assert.equal(needsVoteRefresh(locked, restarted), true);
  assert.equal(needsVoteRefresh(null, locked), true);
  assert.equal(needsVoteRefresh(null, restarted), true);
});

test("needsVoteRefresh: no refresh for an unchanged poll or an idle room", () => {
  const voting = { status: "voting", active_position_id: "p1", poll_expires_at: "x" };
  assert.equal(needsVoteRefresh(voting, { ...voting }), false);
  assert.equal(needsVoteRefresh(voting, { status: "waiting", active_position_id: null, poll_expires_at: null }), false);
  assert.equal(needsVoteRefresh(null, null), false);
  assert.equal(needsVoteRefresh(voting, { ...voting, active_position_id: "p2" }), true);
});

test("parseTimerSeconds accepts whole seconds from 10 to 300 only", () => {
  assert.equal(parseTimerSeconds("60"), 60);
  assert.equal(parseTimerSeconds(" 10 "), 10);
  assert.equal(parseTimerSeconds("300"), 300);
  assert.equal(parseTimerSeconds(""), null);
  assert.equal(parseTimerSeconds("0"), null);
  assert.equal(parseTimerSeconds("9"), null);
  assert.equal(parseTimerSeconds("301"), null);
  assert.equal(parseTimerSeconds("12.5"), null);
  assert.equal(parseTimerSeconds("-30"), null);
  assert.equal(parseTimerSeconds(undefined), null);
});

test("eligibilityChangePrompts names the check-ins lost and asks twice for open", () => {
  assert.deepEqual(eligibilityChangePrompts("pin", "pin", 5), []);
  assert.deepEqual(eligibilityChangePrompts("pin", "", 5), []);
  const toRoster = eligibilityChangePrompts("pin", "roster_csv", 9);
  assert.equal(toRoster.length, 1);
  assert.match(toRoster[0], /signs out 9 checked-in voters/);
  assert.match(eligibilityChangePrompts("pin", "access_code", 1)[0], /signs out 1 checked-in voter\./);
  const toOpen = eligibilityChangePrompts("pin", "open", 0);
  assert.equal(toOpen.length, 2);
  assert.match(toOpen[1], /Anyone with the voter link can vote/);
});

test("joinErrorNeedsElectionRefresh", () => {
  assert.equal(joinErrorNeedsElectionRefresh(401, undefined), true);
  assert.equal(joinErrorNeedsElectionRefresh(403, "code_required"), true);
  assert.equal(joinErrorNeedsElectionRefresh(403, "email_required"), true);
  assert.equal(joinErrorNeedsElectionRefresh(403, "invalid_code"), true);
  assert.equal(joinErrorNeedsElectionRefresh(409, undefined), false);
  assert.equal(joinErrorNeedsElectionRefresh(429, undefined), false);
});

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          await t.fn();
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

test("createCoalescer turns a burst of triggers into one run", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const c = createCoalescer(async () => { runs += 1; }, 750, timers);
  for (let i = 0; i < 50; i++) c.trigger();
  assert.equal(runs, 0);
  await timers.advance(750);
  assert.equal(runs, 1);
  assert.equal(timers.size, 0);
});

test("createCoalescer runs once more when triggered during a run, never two at once", async () => {
  const timers = fakeTimers();
  let inFlight = 0;
  let maxInFlight = 0;
  let runs = 0;
  let release;
  const c = createCoalescer(async () => {
    runs += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => { release = r; });
    inFlight -= 1;
  }, 100, timers);
  c.trigger();
  const first = timers.advance(100); // run 1 starts and waits
  await new Promise((r) => setImmediate(r));
  c.trigger();
  c.trigger();
  c.trigger();
  release();
  await first;
  assert.equal(runs, 1);
  assert.equal(timers.size, 1, "one follow-up run is scheduled");
  const second = timers.advance(100);
  await new Promise((r) => setImmediate(r));
  release();
  await second;
  assert.equal(runs, 2);
  assert.equal(maxInFlight, 1);
  assert.equal(timers.size, 0);
});

test("createCoalescer.cancel drops a scheduled run", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const c = createCoalescer(() => { runs += 1; }, 100, timers);
  c.trigger();
  c.cancel();
  c.trigger();
  await timers.advance(200);
  assert.equal(runs, 0);
});

test("isValidHostPin matches the server's 6 to 8 digit rule", () => {
  for (const ok of ["123456", "12345678"]) assert.equal(isValidHostPin(ok), true, ok);
  for (const bad of ["1975", "12345", "123456789", "12a456", "", null, 123456]) {
    assert.equal(isValidHostPin(bad), false, String(bad));
  }
});
