// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../rate-limit.js";
import {
  ALERT_EVERY,
  DEVICE_FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  IP_FAILURE_LIMIT,
  SLOWDOWN_AT,
  createCheckinGuard,
} from "../checkin-guard.js";

function setup() {
  let t = 1_000_000;
  const now = () => t;
  const main = createRateLimiter({ now });
  const client = createRateLimiter({ now });
  const pick = (opts) => (opts?.client ? client : main);
  const guard = createCheckinGuard({
    blocked: (k, l, w, o) => pick(o).peek(k, l, w),
    record: (k, w, o) => pick(o).record(k, w),
    count: (k, w) => main.count(k, w),
    clear: (k) => main.clear(k),
  });
  return { guard, advance: (ms) => (t += ms) };
}

const E = "0b1e5a8e-7c55-4a4e-9a57-6a0f3f3c2d11";
const dev = (i) => i.toString(16).padStart(64, "0");

test("other devices' wrong PINs never block a voter", () => {
  // 101 wrong PINs, each from a new device id, used to pause check-in for
  // the whole election, voters with the right PIN included.
  const { guard } = setup();
  for (let i = 0; i < 500; i++) guard.recordWrongAnswer(E, { deviceId: dev(i) });
  assert.equal(guard.sourceBlocked(E, { deviceId: dev(10_000) }).ok, true);
  assert.equal(guard.sourceBlocked(E, { ip: "198.51.100.7", deviceId: dev(10_001) }).ok, true);
  assert.equal(guard.stats(E).slowed, true);
});

test("a device that keeps guessing is refused before its answer is checked", () => {
  const { guard, advance } = setup();
  for (let i = 0; i < DEVICE_FAILURE_LIMIT; i++) guard.recordWrongAnswer(E, { deviceId: dev(1) });
  const r = guard.sourceBlocked(E, { deviceId: dev(1) });
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter > 0);
  advance(FAILURE_WINDOW_MS + 1);
  assert.equal(guard.sourceBlocked(E, { deviceId: dev(1) }).ok, true);
});

test("an IP that keeps guessing is refused whatever device ids it makes up", () => {
  const { guard } = setup();
  const ip = "203.0.113.9";
  for (let i = 0; i < IP_FAILURE_LIMIT; i++) guard.recordWrongAnswer(E, { ip, deviceId: dev(i) });
  assert.equal(guard.sourceBlocked(E, { ip, deviceId: dev(999) }).ok, false);
  assert.equal(guard.sourceBlocked(E, { ip: "203.0.113.10", deviceId: dev(999) }).ok, true);
});

test("the election-wide count slows failures, alerts the host, and can be cleared", () => {
  const { guard } = setup();
  const alerts = [];
  for (let i = 0; i < SLOWDOWN_AT + ALERT_EVERY; i++) {
    const r = guard.recordWrongAnswer(E, { deviceId: dev(i) });
    if (r.alert) alerts.push(r.recent);
  }
  assert.deepEqual(alerts, [SLOWDOWN_AT, SLOWDOWN_AT + ALERT_EVERY]);
  assert.equal(guard.slowed(E), true);
  assert.deepEqual(guard.stats(E), { recent: SLOWDOWN_AT + ALERT_EVERY, window_minutes: 10, slowed: true });
  guard.reset(E);
  assert.equal(guard.slowed(E), false);
  assert.equal(guard.stats(E).recent, 0);
});

test("wrong emails count against their source but not toward the election signal", () => {
  const { guard } = setup();
  for (let i = 0; i < SLOWDOWN_AT + 5; i++) guard.recordWrongAnswer(E, { deviceId: dev(i), guess: false });
  assert.equal(guard.slowed(E), false);
  for (let i = 0; i < DEVICE_FAILURE_LIMIT; i++) guard.recordWrongAnswer(E, { deviceId: dev(7777), guess: false });
  assert.equal(guard.sourceBlocked(E, { deviceId: dev(7777) }).ok, false);
});

test("counts are per election", () => {
  const { guard } = setup();
  const other = "1b1e5a8e-7c55-4a4e-9a57-6a0f3f3c2d11";
  for (let i = 0; i < DEVICE_FAILURE_LIMIT; i++) guard.recordWrongAnswer(E, { deviceId: dev(1) });
  assert.equal(guard.sourceBlocked(other, { deviceId: dev(1) }).ok, true);
});
