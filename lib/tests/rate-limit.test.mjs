// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, clientIpFromReq } from "../rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("allows up to the limit, then refuses with a Retry-After", () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(rl.limit("k", 5, 60_000).ok, true);
  const denied = rl.limit("k", 5, 60_000);
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfter, 60);
  c.advance(60_001);
  assert.equal(rl.limit("k", 5, 60_000).ok, true);
});

test("a key first seen while the map is full is still limited", () => {
  // The old sweep deleted the key it had just inserted, so every request for
  // a new key started from zero once more than 5000 keys were tracked.
  const c = clock();
  const rl = createRateLimiter({ maxKeys: 100, now: c.now });
  for (let i = 0; i < 150; i++) rl.limit(`flood:${i}`, 20, 10_000);
  let allowed = 0;
  for (let i = 0; i < 50; i++) if (rl.limit("victim", 5, 60_000).ok) allowed++;
  assert.equal(allowed, 5);
  assert.ok(rl.size() <= 100);
});

test("flooding new keys does not reset a blocked key", () => {
  const c = clock();
  const rl = createRateLimiter({ maxKeys: 50, now: c.now });
  for (let i = 0; i < 5; i++) rl.limit("pin-guesser", 5, 60_000);
  assert.equal(rl.limit("pin-guesser", 5, 60_000).ok, false);
  // 500 made-up keys, all live, ten times the map's capacity.
  for (let i = 0; i < 500; i++) rl.limit(`junk:${i}`, 20, 60_000);
  assert.ok(rl.size() <= 50);
  assert.equal(rl.limit("pin-guesser", 5, 60_000).ok, false);
});

test("a failure counter at its limit survives a flood of fresh keys", () => {
  const c = clock();
  const rl = createRateLimiter({ maxKeys: 20, now: c.now });
  for (let i = 0; i < 3; i++) rl.record("fail:e1", 60_000);
  assert.equal(rl.peek("fail:e1", 3, 60_000).ok, false);
  for (let i = 0; i < 100; i++) rl.record(`fail:junk${i}`, 60_000);
  assert.equal(rl.peek("fail:e1", 3, 60_000).ok, false);
});

test("expired keys are dropped before live ones", () => {
  const c = clock();
  const rl = createRateLimiter({ maxKeys: 10, now: c.now });
  rl.limit("old", 1, 1_000);
  c.advance(5_000);
  for (let i = 1; i <= 10; i++) rl.limit(`live${i}`, 1, 60_000);
  assert.equal(rl.has("old"), false);
  assert.equal(rl.has("live10"), true);
  assert.ok(rl.size() <= 10);
});

test("peek does not count; record counts without a limit", () => {
  const c = clock();
  const rl = createRateLimiter({ now: c.now });
  assert.equal(rl.peek("f", 2, 60_000).ok, true);
  rl.record("f", 60_000);
  assert.equal(rl.peek("f", 2, 60_000).ok, true);
  rl.record("f", 60_000);
  assert.equal(rl.peek("f", 2, 60_000).ok, false);
  c.advance(60_001);
  assert.equal(rl.peek("f", 2, 60_000).ok, true);
});

function req(headers) {
  return { headers: new Headers(headers) };
}

test("X-Forwarded-For is ignored unless TRUSTED_PROXY_HOPS is set", () => {
  assert.equal(clientIpFromReq(req({ "x-forwarded-for": "1.2.3.4" }), {}), null);
  assert.equal(clientIpFromReq(req({ "x-real-ip": "1.2.3.4" }), {}), null);
  assert.equal(clientIpFromReq(req({}), { TRUSTED_PROXY_HOPS: "1" }), null);
});

test("with trusted hops, the client entries to the left are ignored", () => {
  const env = { TRUSTED_PROXY_HOPS: "1" };
  // The client sent "6.6.6.6"; the proxy appended the real address.
  assert.equal(clientIpFromReq(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), env), "203.0.113.9");
  assert.equal(
    clientIpFromReq(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.2" }), {
      TRUSTED_PROXY_HOPS: "2",
    }),
    "203.0.113.9"
  );
  assert.equal(clientIpFromReq(req({ "x-forwarded-for": "203.0.113.9" }), { TRUSTED_PROXY_HOPS: "2" }), null);
});

test("count reports events in the window; clear forgets a key", () => {
  let t = 1_000_000;
  const rl = createRateLimiter({ now: () => t });
  assert.equal(rl.count("f", 60_000), 0);
  rl.record("f", 60_000);
  rl.record("f", 60_000);
  assert.equal(rl.count("f", 60_000), 2);
  t += 60_001;
  assert.equal(rl.count("f", 60_000), 0);
  rl.record("f", 60_000);
  rl.clear("f");
  assert.equal(rl.count("f", 60_000), 0);
  assert.equal(rl.has("f"), false);
});
