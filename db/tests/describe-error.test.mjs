// node --test db/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import pg from "pg";
import { describeDbError, describeDbTarget } from "../../lib/db.js";

const refused = (address) =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });

test("an AggregateError with an empty message still gets a message", () => {
  // What Node throws when "localhost" refuses on both ::1 and 127.0.0.1.
  const err = new AggregateError([refused("::1:5432"), refused("127.0.0.1:5432")], "");
  err.code = "ECONNREFUSED";
  const text = describeDbError(err, "postgres://postgres:secret@localhost:5432/elections");
  assert.match(text, /ECONNREFUSED ::1:5432/);
  assert.match(text, /ECONNREFUSED 127\.0\.0\.1:5432/);
  assert.match(text, /Could not reach Postgres at localhost:5432\/elections/);
  assert.match(text, /docker compose up -d/);
  assert.doesNotMatch(text, /secret/);
});

test("the unreachable hint also fires when only an inner error carries the code", () => {
  const err = new AggregateError([refused("127.0.0.1:5432")], "");
  assert.match(describeDbError(err), /Could not reach Postgres\. Check/);
});

test("other errors keep their message and get no hint", () => {
  const err = Object.assign(new Error('relation "x" does not exist'), { code: "42P01" });
  assert.equal(describeDbError(err, "postgres://localhost/elections"), 'relation "x" does not exist');
});

test("never returns an empty string", () => {
  for (const err of [new Error(""), new AggregateError([], ""), {}, "", null, undefined, 0]) {
    assert.ok(describeDbError(err).length > 0, `empty for ${String(err)}`);
  }
  assert.equal(describeDbError(Object.assign(new Error(""), { code: "ETIMEDOUT" })).startsWith("ETIMEDOUT"), true);
});

test("describeDbTarget drops the user and password", () => {
  assert.equal(describeDbTarget("postgres://app:pw@db.internal:6543/elections"), "db.internal:6543/elections");
  assert.equal(describeDbTarget("postgres://localhost/elections"), "localhost:5432/elections");
  assert.equal(describeDbTarget("not a url"), "");
});

test("a real refused connection to localhost produces a useful message", async () => {
  // Grab a free port, close it, then connect to it through pg.
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const url = `postgres://postgres@localhost:${port}/elections`;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  const err = await client.connect().then(
    () => null,
    (e) => e
  );
  await client.end().catch(() => {});
  assert.ok(err, "expected the connection to fail");
  const text = describeDbError(err, url);
  assert.match(text, /ECONNREFUSED/);
  assert.match(text, new RegExp(`Could not reach Postgres at localhost:${port}/elections`));
});
