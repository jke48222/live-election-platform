// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ballotRef, entryRef, isDeviceId, voterKey } from "../voter-identity.js";

const E = "0b1e5a8e-7c55-4a4e-9a57-6a0f3f3c2d11";
const D = "ab".repeat(32);

test("device ids are 64 lowercase hex characters", () => {
  assert.equal(isDeviceId(D), true);
  assert.equal(isDeviceId(D.toUpperCase()), false);
  assert.equal(isDeviceId("ab"), false);
  assert.equal(isDeviceId(null), false);
});

test("voterKey is the SHA-256 of '<election>:<device>' the voter page computes", () => {
  const expected = createHash("sha256").update(`${E}:${D}`).digest("hex");
  assert.equal(voterKey(E, D), expected);
  assert.equal(voterKey(E.toUpperCase(), D), expected);
});

test("voterKey differs per election and never equals the device id", () => {
  const other = "1b1e5a8e-7c55-4a4e-9a57-6a0f3f3c2d11";
  assert.notEqual(voterKey(E, D), voterKey(other, D));
  assert.notEqual(voterKey(E, D), D);
  assert.throws(() => voterKey(E, "not-a-device"));
});

function fakeDb(rows) {
  return {
    async query(sql, params) {
      assert.match(sql, /claimed_by_device = \$2/);
      return { rows: rows.filter((r) => r.claimed_by_device === params[1]) };
    },
  };
}

test("claim modes vote as the claimed entry; other modes as the device key", async () => {
  const key = voterKey(E, D);
  const db = fakeDb([{ id: "row-1", identifier: "ann voter", claimed_by_device: key }]);
  for (const mode of ["roster_csv", "email_magic_link", "access_code"]) {
    assert.equal(await ballotRef(db, E, mode, key), entryRef(E, "ann voter"));
  }
  for (const mode of ["open", "pin", "sso_oidc"]) {
    assert.equal(await ballotRef(db, E, mode, key), key);
  }
  // A walk-in the host verified by hand holds no entry: votes as the device.
  assert.equal(await ballotRef(fakeDb([]), E, "roster_csv", key), key);
});

test("a deleted and re-added entry keeps its ballot ref", async () => {
  // The ref used to be the row id, and a re-imported roster row got a new
  // id, so the same person could vote twice in a live race.
  const key = voterKey(E, D);
  const before = await ballotRef(fakeDb([{ id: "row-1", identifier: "ann voter", claimed_by_device: key }]), E, "roster_csv", key);
  const after = await ballotRef(fakeDb([{ id: "row-2", identifier: "ann voter", claimed_by_device: key }]), E, "roster_csv", key);
  assert.equal(before, after);
  // Same person on another phone: same ref.
  const other = voterKey(E, "cd".repeat(32));
  const phone2 = await ballotRef(fakeDb([{ id: "row-3", identifier: "ann voter", claimed_by_device: other }]), E, "roster_csv", other);
  assert.equal(phone2, before);
});

test("entryRef is per election and per identifier, and never the raw identifier", () => {
  const other = "1b1e5a8e-7c55-4a4e-9a57-6a0f3f3c2d11";
  const ref = entryRef(E, "ann voter");
  assert.match(ref, /^ev:[0-9a-f]{64}$/);
  assert.equal(entryRef(E.toUpperCase(), "ann voter"), ref);
  assert.notEqual(entryRef(other, "ann voter"), ref);
  assert.notEqual(entryRef(E, "ben voter"), ref);
  assert.ok(!ref.includes("ann"));
  assert.throws(() => entryRef(E, ""));
});
