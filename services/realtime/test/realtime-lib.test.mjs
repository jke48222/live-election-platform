import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLISHED_REALTIME_SECRETS,
  emit,
  issueTicket,
  realtimeSecret,
  sanitizePayload,
  verifyTicket,
  voterTag,
} from "../../../lib/realtime.js";

const E = "0b6f0f1e-4a53-4d0a-9d3e-1f0e2d3c4b5a";
const HASH = "8dd3".padEnd(64, "a");
const SECRET = "x".repeat(40);

function fakeDb() {
  const calls = [];
  return { calls, query: async (text, params) => calls.push({ text, params }) };
}

test("emit never broadcasts a device_hash; it sends a voter_tag instead", async () => {
  const db = fakeDb();
  await emit(db, E, "checkin_verified", { device_hash: HASH });
  const [channel, payload] = db.calls[0].params;
  assert.equal(channel, "election_events");
  assert.ok(!payload.includes(HASH), "payload must not contain the device hash");
  const body = JSON.parse(payload);
  assert.equal(body.data.voter_tag, voterTag(E, HASH));
  assert.equal(body.data.device_hash, undefined);
});

test("emit refuses credential and personal fields at any depth", async () => {
  for (const key of ["pin", "email", "token", "password", "code", "ticket", "secret", "PIN"]) {
    await assert.rejects(emit(fakeDb(), E, "x", { nested: { [key]: "v" } }), /public/);
  }
});

test("emit keeps ordinary state_change payloads unchanged", async () => {
  const db = fakeDb();
  const data = { status: "voting", active_position_id: E, poll_expires_at: "2026-09-29T00:00:00Z" };
  await emit(db, E, "state_change", data);
  assert.deepEqual(JSON.parse(db.calls[0].params[1]), { electionId: E, event: "state_change", data });
});

test("emit tags admin-only events and rejects unknown audiences", async () => {
  const db = fakeDb();
  await emit(db, E, "tally", { n: 1 }, { audience: "admin" });
  assert.equal(JSON.parse(db.calls[0].params[1]).audience, "admin");
  await assert.rejects(emit(db, E, "x", null, { audience: "everyone" }));
});

test("emit rejects payloads over the NOTIFY limit, counting bytes", async () => {
  await assert.rejects(emit(fakeDb(), E, "x", { s: "é".repeat(4000) }), /too large/);
});

test("voter tags differ per election and per secret, and are not the hash", () => {
  const a = voterTag(E, HASH, SECRET);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, voterTag("11111111-1111-1111-1111-111111111111", HASH, SECRET));
  assert.notEqual(a, voterTag(E, HASH, "y".repeat(40)));
  assert.deepEqual(sanitizePayload(E, { device_hash: HASH }, SECRET), { voter_tag: a });
});

test("realtimeSecret requires a real secret in production only", () => {
  assert.throws(() => realtimeSecret({ NODE_ENV: "production" }), /REALTIME_SECRET/);
  assert.throws(() => realtimeSecret({ REALTIME_SECRET: "short" }), /32/);
  assert.equal(realtimeSecret({ NODE_ENV: "production", REALTIME_SECRET: SECRET }), SECRET);
  assert.ok(realtimeSecret({}).length >= 32);
});

test("realtimeSecret refuses a published key outside development", () => {
  assert.equal(PUBLISHED_REALTIME_SECRETS[0], "local-only-realtime-secret-replace-before-deploying");
  for (const published of PUBLISHED_REALTIME_SECRETS) {
    for (const nodeEnv of [undefined, "", "production", "test", "staging"]) {
      assert.throws(
        () => realtimeSecret({ NODE_ENV: nodeEnv, REALTIME_SECRET: published }),
        /published in this repository[\s\S]*openssl rand -hex 32/
      );
    }
    assert.equal(realtimeSecret({ NODE_ENV: "development", REALTIME_SECRET: published }), published);
  }
});

test("tickets verify, bind to one election and scope, and expire", () => {
  const now = Date.now();
  const t = issueTicket({ electionId: E.toUpperCase(), scope: "admin", ttlSeconds: 60, now }, SECRET);
  const claims = verifyTicket(t, SECRET, now);
  assert.equal(claims.electionId, E);
  assert.equal(claims.scope, "admin");
  assert.equal(verifyTicket(t, SECRET, now + 61_000), null, "expired");
  assert.equal(verifyTicket(t, "z".repeat(40), now), null, "wrong secret");
  const [v, body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ e: E, s: "admin", x: 9e9 })).toString("base64url");
  assert.equal(verifyTicket(`${v}.${forged}.${sig}`, SECRET, now), null, "tampered body");
  assert.equal(verifyTicket(`${v}.${body}.`, SECRET, now), null, "missing signature");
  assert.equal(verifyTicket("garbage", SECRET, now), null);
  assert.equal(verifyTicket(null, SECRET, now), null);
  assert.throws(() => issueTicket({ electionId: E, scope: "root" }, SECRET));
});
