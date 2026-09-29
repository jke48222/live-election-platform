// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  pinMatches,
  releaseClaims,
  resolveEligibility,
} from "../eligibility.js";

test("pinMatches fails closed", () => {
  assert.equal(pinMatches("4821", "4821"), true);
  assert.equal(pinMatches("4821", "4822"), false);
  // A PIN election with no PIN set used to admit { pin: null }.
  assert.equal(pinMatches(null, null), false);
  assert.equal(pinMatches(null, ""), false);
  assert.equal(pinMatches("", ""), false);
  assert.equal(pinMatches("4821", 4821), false);
  assert.equal(pinMatches("4821", undefined), false);
});

/**
 * A tiny stand-in for the eligible_voters queries resolveEligibility runs.
 * It applies the claim UPDATE with the same WHERE rule as the SQL, so the
 * tests exercise the claim logic, not Postgres.
 */
function fakeDb(entries) {
  const matches = (sql, row, value) =>
    sql.includes("lower(token) = $2")
      ? row.token !== null && row.token.toLowerCase() === value
      : row.token === null && row.identifier === value;
  return {
    entries,
    async query(sql, params) {
      if (sql.includes("SET claimed_by_device = NULL")) {
        for (const r of entries) if (r.claimed_by_device === params[1]) r.claimed_by_device = null;
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE eligible_voters")) {
        const [, value, key] = params;
        const hit = entries.find(
          (r) => matches(sql, r, value) && (r.claimed_by_device === null || r.claimed_by_device === key)
        );
        if (!hit) return { rows: [] };
        hit.claimed_by_device = key;
        return { rows: [{ id: hit.id }] };
      }
      if (sql.includes("claimed_by_device = $2")) {
        return { rows: entries.filter((r) => r.claimed_by_device === params[1]) };
      }
      if (sql.includes("SELECT 1 FROM eligible_voters")) {
        return { rows: entries.filter((r) => matches(sql, r, params[1])).map(() => ({ "?column?": 1 })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const E = { id: "e1" };
const roster = () =>
  fakeDb([
    { id: "ada", identifier: "ada lovelace", token: null, claimed_by_device: null },
    { id: "alan", identifier: "alan turing", token: null, claimed_by_device: null },
    { id: "email", identifier: "ada@example.com", token: null, claimed_by_device: null },
    { id: "code", identifier: "abc123", token: "ABC123", claimed_by_device: null },
  ]);

test("roster: a listed name is verified and claimed; a second device is refused", async () => {
  const db = roster();
  const mode = { ...E, eligibility_mode: "roster_csv" };
  const a = await resolveEligibility(db, mode, { displayName: "Ada  Lovelace", voterKey: "A" });
  assert.deepEqual([a.ok, a.verified, a.claimId], [true, true, "ada"]);
  const again = await resolveEligibility(db, mode, { displayName: "ada lovelace", voterKey: "A" });
  assert.equal(again.verified, true);
  const b = await resolveEligibility(db, mode, { displayName: "Ada Lovelace", voterKey: "B" });
  assert.deepEqual([b.ok, b.status, b.code], [false, 409, "identity_in_use"]);
});

test("roster: a device holding a name cannot switch to another name", async () => {
  // The old flow let device A re-check-in as someone else to free the name,
  // then device B took it and voted again.
  const db = roster();
  const mode = { ...E, eligibility_mode: "roster_csv" };
  await resolveEligibility(db, mode, { displayName: "Ada Lovelace", voterKey: "A" });
  const renamed = await resolveEligibility(db, mode, { displayName: "Zed Nobody", voterKey: "A" });
  assert.deepEqual([renamed.ok, renamed.status, renamed.code], [false, 409, "identity_locked"]);
  const b = await resolveEligibility(db, mode, { displayName: "Ada Lovelace", voterKey: "B" });
  assert.equal(b.ok, false);
});

test("roster: an unlisted name checks in pending, and codes are not names", async () => {
  const db = roster();
  const mode = { ...E, eligibility_mode: "roster_csv" };
  const walkIn = await resolveEligibility(db, mode, { displayName: "Bob Stranger", voterKey: "W" });
  assert.deepEqual([walkIn.ok, walkIn.verified], [true, false]);
  const codeAsName = await resolveEligibility(db, mode, { displayName: "abc123", voterKey: "X" });
  assert.equal(codeAsName.verified, false);
});

test("email: one listed email backs one device", async () => {
  const db = roster();
  const mode = { ...E, eligibility_mode: "email_magic_link" };
  const c1 = await resolveEligibility(db, mode, { displayName: "Ada", email: "ADA@example.com", voterKey: "C1" });
  assert.equal(c1.verified, true);
  const c2 = await resolveEligibility(db, mode, { displayName: "Ada", email: "ada@example.com", voterKey: "C2" });
  assert.deepEqual([c2.ok, c2.status, c2.code], [false, 409, "identity_in_use"]);
  const nobody = await resolveEligibility(db, mode, { displayName: "N", email: "no@example.com", voterKey: "N" });
  assert.deepEqual([nobody.ok, nobody.code, nobody.failure], [false, "not_eligible", true]);
});

test("access code: first device wins, reuse and bad codes count as failures", async () => {
  const db = roster();
  const mode = { ...E, eligibility_mode: "access_code" };
  const first = await resolveEligibility(db, mode, { code: "abc123", voterKey: "E" });
  assert.equal(first.verified, true);
  const same = await resolveEligibility(db, mode, { code: "ABC123", voterKey: "E" });
  assert.equal(same.verified, true);
  const other = await resolveEligibility(db, mode, { code: "ABC123", voterKey: "F" });
  assert.deepEqual([other.status, other.code, other.failure], [403, "code_used", true]);
  const bad = await resolveEligibility(db, mode, { code: "ZZZ999", voterKey: "G" });
  assert.deepEqual([bad.code, bad.failure], ["invalid_code", true]);
  const none = await resolveEligibility(db, mode, { code: "", voterKey: "G" });
  assert.equal(none.code, "code_required");
});

test("releasing a device's claims frees the entry for another device", async () => {
  const db = roster();
  const mode = { ...E, eligibility_mode: "access_code" };
  await resolveEligibility(db, mode, { code: "ABC123", voterKey: "E" });
  await releaseClaims(db, "e1", "E");
  const next = await resolveEligibility(db, mode, { code: "ABC123", voterKey: "F" });
  assert.equal(next.verified, true);
});

test("open and pin modes need no list", async () => {
  for (const m of ["open", "pin"]) {
    const r = await resolveEligibility(fakeDb([]), { ...E, eligibility_mode: m }, { voterKey: "K" });
    assert.deepEqual([r.ok, r.verified], [true, true]);
  }
});
