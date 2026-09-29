// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { loadOrCreateDeviceId, randomDeviceId } from "../fingerprint.js";

const ID_RE = /^[0-9a-f]{64}$/;

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

function fakeDoc() {
  const jar = new Map();
  return {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(line) {
      const [pair] = line.split(";");
      const [k, v] = pair.split("=");
      jar.set(k.trim(), v);
    },
  };
}

test("ids are random 64-hex strings, not a fingerprint", () => {
  const a = randomDeviceId(webcrypto);
  const b = randomDeviceId(webcrypto);
  assert.match(a, ID_RE);
  assert.notEqual(a, b); // two identical phones no longer collide
});

test("the id is created once and reused across page loads", () => {
  const storage = memoryStorage();
  const doc = fakeDoc();
  const first = loadOrCreateDeviceId({ storage, doc, crypto: webcrypto });
  const second = loadOrCreateDeviceId({ storage, doc, crypto: webcrypto });
  assert.match(first, ID_RE);
  assert.equal(second, first);
  assert.equal(storage.m.get("ev_device_id"), first);
});

test("falls back to the cookie when localStorage is cleared or blocked", () => {
  const doc = fakeDoc();
  const first = loadOrCreateDeviceId({ storage: memoryStorage(), doc, crypto: webcrypto });
  const blocked = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("SecurityError");
    },
  };
  assert.equal(loadOrCreateDeviceId({ storage: blocked, doc, crypto: webcrypto }), first);
  assert.equal(loadOrCreateDeviceId({ storage: memoryStorage(), doc, crypto: webcrypto }), first);
});

test("a malformed stored value is replaced", () => {
  const storage = memoryStorage({ ev_device_id: "not-an-id" });
  const id = loadOrCreateDeviceId({ storage, doc: null, crypto: webcrypto });
  assert.match(id, ID_RE);
});
