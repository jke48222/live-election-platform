// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../rate-limit.js";
import {
  ACCOUNT_CEILING,
  FAILURE_WINDOW_MS,
  KNOWN_DEVICE_COOKIE,
  SOURCE_FAILURES,
  knownDeviceCookieHeader,
  knownDeviceNonce,
  knownDeviceValue,
  loginFailurePlan,
} from "../login-guard.js";

const SECRET = "x".repeat(40);
const EMAIL = "host@example.org";
const req = (cookie) => ({ headers: new Headers(cookie ? { cookie } : {}) });

/** Replays a series of wrong passwords through the plan, like the route does. */
function attempt(rl, ctx) {
  const plan = loginFailurePlan(ctx);
  for (const { key, limit } of plan.checks) {
    if (!rl.peek(key, limit, FAILURE_WINDOW_MS).ok) return "blocked";
  }
  for (const key of plan.records) rl.record(key, FAILURE_WINDOW_MS);
  return "wrong";
}

test("a known-device cookie is bound to its email and signed", () => {
  const value = knownDeviceValue(EMAIL, SECRET);
  const nonce = knownDeviceNonce(req(`a=1; ${KNOWN_DEVICE_COOKIE}=${value}`), EMAIL, SECRET);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(knownDeviceNonce(req(`${KNOWN_DEVICE_COOKIE}=${value}`), "other@example.org", SECRET), null);
  assert.equal(knownDeviceNonce(req(`${KNOWN_DEVICE_COOKIE}=${value}`), EMAIL, "y".repeat(40)), null);
  const forged = `${value.slice(0, 33)}${"0".repeat(64)}`;
  assert.equal(knownDeviceNonce(req(`${KNOWN_DEVICE_COOKIE}=${forged}`), EMAIL, SECRET), null);
  assert.equal(knownDeviceNonce(req(null), EMAIL, SECRET), null);
  assert.equal(knownDeviceNonce(req(`${KNOWN_DEVICE_COOKIE}=${value}`), EMAIL, null), null);
  const header = knownDeviceCookieHeader(value, { secure: true });
  assert.match(header, /HttpOnly/);
  assert.match(header, /Path=\/api\/auth\/login/);
  assert.match(header, /Secure/);
});

test("strangers' wrong passwords never lock out a browser the host signed in from", () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 50; i++) attempt(rl, { email: EMAIL, ip: null, knownNonce: null });
  assert.equal(attempt(rl, { email: EMAIL, ip: null, knownNonce: null }), "blocked");
  assert.equal(attempt(rl, { email: EMAIL, ip: null, knownNonce: "a".repeat(32) }), "wrong");
});

test("with client IPs, one IP's failures do not block another IP", () => {
  const rl = createRateLimiter();
  for (let i = 0; i < SOURCE_FAILURES; i++) attempt(rl, { email: EMAIL, ip: "203.0.113.1" });
  assert.equal(attempt(rl, { email: EMAIL, ip: "203.0.113.1" }), "blocked");
  assert.equal(attempt(rl, { email: EMAIL, ip: "198.51.100.2" }), "wrong");
});

test("with client IPs, the account-wide ceiling still stops a spread-out attack", () => {
  const rl = createRateLimiter();
  for (let i = 0; i < ACCOUNT_CEILING; i++) attempt(rl, { email: EMAIL, ip: `10.0.${i >> 8}.${i & 255}` });
  assert.equal(attempt(rl, { email: EMAIL, ip: "10.9.9.9" }), "blocked");
});

test("a known device's own failures are limited", () => {
  const rl = createRateLimiter();
  const nonce = "b".repeat(32);
  for (let i = 0; i < 10; i++) attempt(rl, { email: EMAIL, knownNonce: nonce });
  assert.equal(attempt(rl, { email: EMAIL, knownNonce: nonce }), "blocked");
});

test("each source gets its own burst key", () => {
  const a = loginFailurePlan({ email: EMAIL, ip: "203.0.113.1" }).burst;
  const b = loginFailurePlan({ email: EMAIL, ip: "203.0.113.2" }).burst;
  const k = loginFailurePlan({ email: EMAIL, knownNonce: "c".repeat(32) }).burst;
  assert.equal(new Set([a, b, k, loginFailurePlan({ email: EMAIL }).burst]).size, 4);
});
