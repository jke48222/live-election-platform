import { test } from "node:test";
import assert from "node:assert/strict";
import { clampDuration, DURATION_MIN_SEC, DURATION_MAX_SEC } from "../api-helpers.js";
import { POLL_TIMER_MIN_SEC, POLL_TIMER_MAX_SEC } from "../../app/_lib/poll.js";

test("the server's poll timer range matches the console's", () => {
  assert.equal(DURATION_MIN_SEC, POLL_TIMER_MIN_SEC);
  assert.equal(DURATION_MAX_SEC, POLL_TIMER_MAX_SEC);
});

test("clampDuration keeps a poll between 10 and 300 seconds", () => {
  assert.equal(clampDuration(5), 10);
  assert.equal(clampDuration(0), 10);
  assert.equal(clampDuration(-30), 10);
  assert.equal(clampDuration(10), 10);
  assert.equal(clampDuration(120.9), 120);
  assert.equal(clampDuration("90"), 90);
  assert.equal(clampDuration(300), 300);
  assert.equal(clampDuration(600), 300);
});

test("clampDuration falls back when the value is not a number", () => {
  assert.equal(clampDuration(undefined), 60);
  assert.equal(clampDuration("soon"), 60);
  assert.equal(clampDuration(Infinity, 45), 45);
});
