// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyLogin, verifyPassword } from "../auth.js";

test("hashing is async and round-trips", async () => {
  const pending = hashPassword("correct horse");
  assert.ok(pending instanceof Promise);
  const stored = await pending;
  assert.match(stored, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("wrong horse", stored), false);
});

test("malformed stored hashes are rejected, not thrown", async () => {
  for (const bad of [null, "", "plain", "scrypt$", "scrypt$x$y$z$00$00", "scrypt$16384$8$1$zz$"]) {
    assert.equal(await verifyPassword("pw", bad), false, String(bad));
  }
});

test("hashing does not block the event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await Promise.all([hashPassword("a"), hashPassword("b"), hashPassword("c")]);
  clearInterval(timer);
  assert.ok(ticks > 0, "timers ran while scrypt was hashing");
});

test("an unknown account costs a hash too, and never logs in", async () => {
  const stored = await hashPassword("pw12345678");
  const t0 = performance.now();
  assert.equal(await verifyLogin("pw12345678", null), false);
  const unknownMs = performance.now() - t0;
  const t1 = performance.now();
  assert.equal(await verifyLogin("pw12345678", stored), true);
  const knownMs = performance.now() - t1;
  // Same order of cost: the unknown path runs scrypt instead of returning at once.
  assert.ok(unknownMs > knownMs / 4, `unknown ${unknownMs}ms vs known ${knownMs}ms`);
});
