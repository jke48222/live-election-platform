#!/usr/bin/env node
/**
 * Checks Postgres tenant isolation against a migrated database.
 *
 *   node --env-file=.env.local db/verify-rls.mjs
 *
 * As the owner (DATABASE_URL) it creates two throwaway orgs, A and B, and one
 * row per org in every tenant table. Then, connected as the `app` role
 * (APP_DATABASE_URL), it checks:
 *
 *   Connection
 *     - lib/db.js refuses to pick a connection outside development without
 *       APP_DATABASE_URL, and never falls back to DATABASE_URL.
 *     - the realtime gateway (services/realtime/config.mjs) follows the same
 *       rule whenever NODE_ENV is not development, including unset.
 *     - the app role is not a superuser, has no BYPASSRLS, and owns no RLS
 *       table, so RLS applies to it. The same check guards every query the
 *       server makes.
 *   Every tenant table
 *     - RLS is enabled and an org_isolation policy exists.
 *     - scoped to A, only A's rows are visible; scoped to B, only B's.
 *     - with no org context, no rows are visible.
 *     - scoped to A, inserting a row tagged B is rejected.
 *     - scoped to A, updating or deleting B's row touches nothing, and moving
 *       A's row to B is rejected.
 *   Ballot secrecy
 *     - votes is a view over per-candidate counters (vote_tallies), with
 *       no voter identity and no timestamp; the view shows only the
 *       current org's votes, and the app cannot insert into it.
 *     - cast_ballot records one vote per voter per position.
 *     - clearing a position's votes lets its voters vote again.
 *     - four named voters vote A, B, A, B in separate transactions; as the
 *       owner, neither xmin nor row order matches any of them to a choice.
 *   Voter lookup indexes
 *     - the check-in and vote lookups by (election, voter) can use the
 *       indexes from 0008_voter_lookup_indexes.sql.
 *   Upgrade (db/verify-upgrade.mjs)
 *     - in a scratch database, data in the format of the committed
 *       single-tenant schema (raw device ids, one votes row per vote) is
 *       migrated, and every stored identity comes out as voterKey() would
 *       compute it, with one ballot per voter per race and the counts kept.
 *
 * Leftover orgs from an aborted run are removed first, and both orgs are
 * removed at the end. Exits non-zero on any failed check.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertRlsEnforced, describeDbError, resolveAppDatabaseUrl } from "../lib/db.js";
import { resolveGatewayConfig } from "../services/realtime/config.mjs";
import { checkUpgrade } from "./verify-upgrade.mjs";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/elections";
const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://app:app_local_dev@localhost:5432/elections";

const SLUG_PREFIX = "rls-test-";

// Every table that carries org_id and must be isolated by RLS.
const TENANT_TABLES = [
  "elections",
  "positions",
  "candidates",
  "eligible_voters",
  "checkins",
  "vote_tallies",
  "ballots_cast",
  "audit_log",
];

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.log(`  FAIL  ${msg}`);
    failures++;
  }
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Run `fn` as the app role inside a transaction that is always rolled back. */
async function asApp(app, orgId, fn) {
  await app.query("BEGIN");
  try {
    if (orgId) await app.query("SELECT set_config('app.current_org',$1,true)", [orgId]);
    return await fn();
  } finally {
    await app.query("ROLLBACK");
  }
}

/** Returns the SQLSTATE a statement fails with, or null if it succeeds. */
async function errorCode(app, sql, params) {
  await app.query("SAVEPOINT probe");
  try {
    await app.query(sql, params);
    await app.query("RELEASE SAVEPOINT probe");
    return null;
  } catch (err) {
    await app.query("ROLLBACK TO SAVEPOINT probe");
    return err.code || "unknown";
  }
}

/** Creates one org with one row in every tenant table. Returns { orgId, rows }. */
async function seedOrg(owner, label) {
  const one = async (sql, params) => (await owner.query(sql, params)).rows[0];
  const org = await one(
    "INSERT INTO organizations (slug,name) VALUES ($1,$2) RETURNING id",
    [`${SLUG_PREFIX}${label.toLowerCase()}-${randomUUID().slice(0, 8)}`, `RLS Test ${label}`]
  );
  const orgId = org.id;
  const rows = {};
  rows.elections = await one(
    "INSERT INTO elections (org_id,slug,title) VALUES ($1,'e',$2) RETURNING *",
    [orgId, `Election ${label}`]
  );
  const electionId = rows.elections.id;
  rows.positions = await one(
    "INSERT INTO positions (election_id,org_id,title) VALUES ($1,$2,'President') RETURNING *",
    [electionId, orgId]
  );
  const positionId = rows.positions.id;
  rows.candidates = await one(
    "INSERT INTO candidates (position_id,org_id,name) VALUES ($1,$2,$3) RETURNING *",
    [positionId, orgId, `Candidate ${label}`]
  );
  rows.eligible_voters = await one(
    "INSERT INTO eligible_voters (election_id,org_id,identifier) VALUES ($1,$2,$3) RETURNING *",
    [electionId, orgId, `voter-${label}`]
  );
  rows.checkins = await one(
    `INSERT INTO checkins (election_id,org_id,device_hash,display_name)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [electionId, orgId, `device-${label}`, `Voter ${label}`]
  );
  rows.vote_tallies = await one(
    `INSERT INTO vote_tallies (election_id,org_id,position_id,candidate_id,n)
     VALUES ($1,$2,$3,$4,1) RETURNING *`,
    [electionId, orgId, positionId, rows.candidates.id]
  );
  rows.ballots_cast = await one(
    `INSERT INTO ballots_cast (election_id,org_id,position_id,voter_ref)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [electionId, orgId, positionId, `device-${label}`]
  );
  rows.audit_log = await one(
    "INSERT INTO audit_log (org_id,actor,action) VALUES ($1,'rls-test','verify') RETURNING *",
    [orgId]
  );
  return { orgId, rows };
}

async function checkConnectionRules(app) {
  console.log("\nConnection");
  let threw = false;
  try {
    resolveAppDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: "postgres://owner@db/x" });
  } catch {
    threw = true;
  }
  check(threw, "without APP_DATABASE_URL outside development, lib/db.js refuses to connect");
  check(
    resolveAppDatabaseUrl({
      NODE_ENV: "production",
      APP_DATABASE_URL: "postgres://app@db/x",
      DATABASE_URL: "postgres://owner@db/x",
    }) === "postgres://app@db/x",
    "lib/db.js uses APP_DATABASE_URL, not DATABASE_URL"
  );
  // The realtime gateway resolves its connection the same way. Anything but
  // NODE_ENV=development, including unset, counts as production there.
  for (const nodeEnv of [undefined, "test", "production"]) {
    let gatewayThrew = false;
    try {
      resolveGatewayConfig({
        NODE_ENV: nodeEnv,
        DATABASE_URL: "postgres://owner@db/x",
        REALTIME_SECRET: "x".repeat(40),
        REALTIME_ALLOWED_ORIGINS: "https://vote.example.org",
      });
    } catch {
      gatewayThrew = true;
    }
    check(
      gatewayThrew,
      `without APP_DATABASE_URL the realtime gateway refuses to start (NODE_ENV=${nodeEnv ?? "unset"})`
    );
  }
  let roleError = null;
  try {
    await assertRlsEnforced(app);
  } catch (err) {
    roleError = err.message;
  }
  check(roleError === null, `app role cannot bypass RLS${roleError ? ` (${roleError})` : ""}`);
}

/**
 * The per-voter lookups on every check-in and vote can use the indexes from
 * 0008_voter_lookup_indexes.sql. Seq scans are turned off for the EXPLAIN,
 * because on a table this small the planner would scan it whatever indexes
 * exist; the check is that a matching index is there to use.
 */
async function checkVoterLookupIndexes(app, A) {
  console.log("\nVoter lookup indexes");
  const electionId = A.rows.elections.id;
  const plan = (sql, params) =>
    asApp(app, A.orgId, async () => {
      await app.query("SET LOCAL enable_seqscan = off");
      const { rows } = await app.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      return JSON.stringify(rows[0]["QUERY PLAN"]);
    });
  const ballots = await plan(
    "SELECT DISTINCT position_id FROM ballots_cast WHERE election_id=$1 AND voter_ref=$2",
    [electionId, "device-A"]
  );
  check(ballots.includes("idx_ballots_cast_voter"), "a voter's ballots are found through idx_ballots_cast_voter");
  const claim = await plan(
    `SELECT identifier FROM eligible_voters
      WHERE election_id=$1 AND claimed_by_device=$2
      ORDER BY used_at NULLS LAST, id LIMIT 1`,
    [electionId, "device-A"]
  );
  check(claim.includes("idx_eligible_claimed"), "a device's roster entry is found through idx_eligible_claimed");
}

async function checkTable(owner, app, table, A, B) {
  console.log(`\n${table}`);
  const meta = await owner.query(
    `SELECT c.relrowsecurity,
            EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname='public' AND p.tablename=c.relname
                       AND p.policyname='org_isolation') AS has_policy
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1`,
    [table]
  );
  check(meta.rows[0]?.relrowsecurity === true, "row-level security is enabled");
  check(meta.rows[0]?.has_policy === true, "org_isolation policy exists");

  const t = quoteIdent(table);
  const aRow = A.rows[table];
  const bRow = B.rows[table];

  for (const [name, me] of [["A", A], ["B", B]]) {
    const seen = await asApp(app, me.orgId, async () =>
      (await app.query(`SELECT id FROM ${t}`)).rows
    );
    check(
      seen.length > 0 && seen.every((r) => r.id !== (name === "A" ? bRow : aRow).id) &&
        seen.some((r) => r.id === me.rows[table].id),
      `scoped to ${name}: sees its own row and not the other org's`
    );
    const leaked = await asApp(app, me.orgId, async () =>
      (await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE org_id IS DISTINCT FROM $1`, [
        me.orgId,
      ])).rows[0].n
    );
    check(leaked === 0, `scoped to ${name}: sees no row from any other org`);
  }

  const none = await asApp(app, null, async () =>
    (await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n
  );
  check(none === 0, "no org context: sees zero rows");

  // Cross-org INSERT: B's row with fresh unique values, submitted while scoped to A.
  const smuggled = { ...bRow, id: randomUUID() };
  for (const col of ["slug", "identifier", "device_hash", "voter_ref"]) {
    if (col in smuggled) smuggled[col] = `smuggled-${randomUUID()}`;
  }
  const insertCode = await asApp(app, A.orgId, () =>
    errorCode(app, `INSERT INTO ${t} SELECT * FROM json_populate_record(null::${t}, $1)`, [
      JSON.stringify(smuggled),
    ])
  );
  check(
    insertCode === "42501",
    `scoped to A: inserting a row tagged B is rejected (got ${insertCode ?? "success"})`
  );

  const updated = await asApp(app, A.orgId, async () =>
    (await app.query(`UPDATE ${t} SET org_id = org_id WHERE id = $1`, [bRow.id])).rowCount
  );
  check(updated === 0, "scoped to A: updating B's row touches nothing");

  const moveCode = await asApp(app, A.orgId, () =>
    errorCode(app, `UPDATE ${t} SET org_id = $1 WHERE id = $2`, [B.orgId, aRow.id])
  );
  check(
    moveCode === "42501",
    `scoped to A: moving A's row to B is rejected (got ${moveCode ?? "success"})`
  );

  const deleted = await asApp(app, A.orgId, async () =>
    (await app.query(`DELETE FROM ${t} WHERE id = $1`, [bRow.id])).rowCount
  );
  const still = (await owner.query(`SELECT 1 FROM ${t} WHERE id = $1`, [bRow.id])).rowCount;
  check(deleted === 0 && still === 1, "scoped to A: deleting B's row touches nothing");
}

async function checkBallotSecrecy(owner, app, A, B) {
  console.log("\nBallot secrecy");
  const columns = async (table) =>
    (
      await owner.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`,
        [table]
      )
    ).rows.map((r) => r.column_name);

  const kind = (
    await owner.query(
      `SELECT c.relkind, c.reloptions FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='votes'`
    )
  ).rows[0];
  check(kind?.relkind === "v", "votes is a view, so no table holds one row per vote");
  check(
    (kind?.reloptions || []).includes("security_invoker=true"),
    "the votes view runs as the caller, so the caller's RLS applies"
  );
  const voteCols = await columns("votes");
  check(
    voteCols.join(",") === "candidate_id,election_id,org_id,position_id",
    `votes holds only ids, no voter identity or timestamp (columns: ${voteCols.join(", ")})`
  );
  const tallyCols = await columns("vote_tallies");
  check(
    !tallyCols.some((c) => /voter|device|_at$|time/.test(c)),
    `vote_tallies holds no voter identity and no timestamp (columns: ${tallyCols.join(", ")})`
  );
  const ballotCols = await columns("ballots_cast");
  check(
    !ballotCols.includes("candidate_id") && !ballotCols.some((c) => /_at$|time/.test(c)),
    `ballots_cast holds no choice and no timestamp (columns: ${ballotCols.join(", ")})`
  );

  // The view shows only the current org's votes.
  for (const [name, me] of [["A", A], ["B", B]]) {
    const other = me === A ? B : A;
    const seen = await asApp(app, me.orgId, async () =>
      (await app.query("SELECT org_id FROM votes")).rows
    );
    check(
      seen.length > 0 && seen.every((r) => r.org_id === me.orgId),
      `votes view scoped to ${name}: sees its own votes and none of the other org's`
    );
    const deleted = await asApp(app, me.orgId, async () =>
      (await app.query("DELETE FROM votes WHERE org_id=$1", [other.orgId])).rowCount
    );
    check(deleted === 0, `votes view scoped to ${name}: deleting the other org's votes touches nothing`);
  }
  const unscoped = await asApp(app, null, async () =>
    (await app.query("SELECT count(*)::int AS n FROM votes")).rows[0].n
  );
  check(unscoped === 0, "votes view with no org context: sees zero rows");

  const { elections, positions, candidates } = A.rows;
  const insertCode = await asApp(app, A.orgId, () =>
    errorCode(
      app,
      "INSERT INTO votes (election_id,org_id,position_id,candidate_id) VALUES ($1,$2,$3,$4)",
      [elections.id, A.orgId, positions.id, candidates.id]
    )
  );
  // Postgres refuses before the privilege check (55000, a view with no
  // INSERT rule), and the app has no INSERT grant on it either (42501).
  check(
    insertCode === "55000" || insertCode === "42501",
    `the app cannot add a vote except through cast_ballot (got ${insertCode ?? "success"})`
  );

  const voter = `ballot-${randomUUID()}`;
  const cast = async (candidateId = candidates.id, ref = voter) =>
    (
      await app.query("SELECT cast_ballot($1,$2,$3,$4) AS ok", [
        elections.id,
        positions.id,
        candidateId,
        ref,
      ])
    ).rows[0].ok;
  const count = async (table) =>
    (await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE position_id=$1`, [
      positions.id,
    ])).rows[0].n;

  const result = await asApp(app, A.orgId, async () => {
    const first = await cast();
    const second = await cast();
    const votes = await count("votes");
    // Clearing the position (runoff or reset) must reopen it for its voters.
    const cleared = (await app.query("DELETE FROM votes WHERE position_id=$1", [positions.id]))
      .rowCount;
    const votesLeft = await count("votes");
    const ballotsLeft = await count("ballots_cast");
    const again = await cast();
    return { first, second, votes, cleared, votesLeft, ballotsLeft, again };
  });
  check(result.first === true, "cast_ballot records a first vote");
  check(result.second === false, "cast_ballot refuses a second vote from the same voter");
  // A's seeded vote plus the one cast above.
  check(result.votes === 2, `the second attempt added no vote (votes: ${result.votes})`);
  check(
    result.cleared === 2 && result.votesLeft === 0,
    `DELETE FROM votes clears the race and reports each vote (deleted ${result.cleared}, left ${result.votesLeft})`
  );
  check(result.ballotsLeft === 0, "clearing a position's votes clears who voted there");
  check(result.again === true, "after clearing, the voter can vote again");

  const noOrg = await asApp(app, null, () =>
    errorCode(app, "SELECT cast_ballot($1,$2,$3,$4)", [
      elections.id,
      positions.id,
      candidates.id,
      voter,
    ])
  );
  check(noOrg === "42501", "cast_ballot refuses to run without an org context");

  const wrongRace = await asApp(app, A.orgId, () =>
    errorCode(app, "SELECT cast_ballot($1,$2,$3,$4)", [
      elections.id,
      positions.id,
      B.rows.candidates.id,
      voter,
    ])
  );
  check(wrongRace !== null, "cast_ballot refuses a candidate from outside the race");

  await checkNoLinkFromVoterToChoice(owner, app, A);
}

/**
 * The attack from the security review: named voters check in and vote, each
 * in its own committed transaction, then the owner tries to match each check-in
 * to a choice through xmin or row order. Uses its own race in org A, which
 * main() deletes with the org.
 */
async function checkNoLinkFromVoterToChoice(owner, app, A) {
  const orgId = A.orgId;
  const electionId = A.rows.elections.id;
  const position = (
    await owner.query(
      "INSERT INTO positions (election_id,org_id,title) VALUES ($1,$2,'Treasurer') RETURNING id",
      [electionId, orgId]
    )
  ).rows[0].id;
  const cand = [];
  for (const name of ["Choice A", "Choice B"]) {
    cand.push(
      (
        await owner.query(
          "INSERT INTO candidates (position_id,org_id,name) VALUES ($1,$2,$3) RETURNING id",
          [position, orgId, name]
        )
      ).rows[0].id
    );
  }
  const plan = [0, 1, 0, 1];
  const voters = plan.map((_, i) => ({ name: `Secret Voter ${i + 1}`, key: randomUUID() }));
  for (const [i, v] of voters.entries()) {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_org',$1,true)", [orgId]);
      await app.query(
        `INSERT INTO checkins (election_id,org_id,device_hash,display_name) VALUES ($1,$2,$3,$4)`,
        [electionId, orgId, v.key, v.name]
      );
      await app.query("COMMIT");
    } catch (err) {
      await app.query("ROLLBACK");
      throw err;
    }
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.current_org',$1,true)", [orgId]);
      await app.query("SELECT cast_ballot($1,$2,$3,$4)", [electionId, position, cand[plan[i]], v.key]);
      await app.query("COMMIT");
    } catch (err) {
      await app.query("ROLLBACK");
      throw err;
    }
  }

  const counts = (
    await owner.query(
      "SELECT candidate_id, n FROM vote_tallies WHERE position_id=$1 ORDER BY candidate_id",
      [position]
    )
  ).rows;
  check(
    counts.length === 2 && counts.every((r) => r.n === 2),
    `four ballots are counted two and two (${counts.map((r) => r.n).join(", ")})`
  );

  // The review's query. votes is a view, so it has no xmin to join on.
  const reviewQuery = await (async () => {
    await owner.query("BEGIN");
    try {
      return await errorCode(
        owner,
        `SELECT c.display_name FROM votes v
           JOIN ballots_cast b ON b.xmin = v.xmin AND b.position_id = v.position_id
           JOIN checkins c ON c.device_hash = b.voter_ref`
      );
    } finally {
      await owner.query("ROLLBACK");
    }
  })();
  check(reviewQuery === "42703", `joining votes to ballots on xmin is not possible (got ${reviewQuery ?? "success"})`);

  // The same join against the counters: a ballot's xmin either matches no
  // counter or every counter of its race, never just the one it chose.
  const matches = (
    await owner.query(
      `SELECT c.display_name,
              count(t.id)::int AS matched,
              (SELECT count(*)::int FROM vote_tallies WHERE position_id = $1) AS race_size
         FROM ballots_cast b
         JOIN checkins c ON c.device_hash = b.voter_ref AND c.election_id = b.election_id
         LEFT JOIN vote_tallies t ON t.xmin = b.xmin AND t.position_id = b.position_id
        WHERE b.position_id = $1
        GROUP BY c.display_name`,
      [position]
    )
  ).rows;
  check(
    matches.length === 4 && matches.every((r) => r.matched === 0 || r.matched === r.race_size),
    "as the owner, joining ballots to counters on xmin picks out no voter's choice"
  );
  const xmins = (
    await owner.query(
      "SELECT count(DISTINCT xmin::text)::int AS n FROM vote_tallies WHERE position_id=$1",
      [position]
    )
  ).rows[0].n;
  check(xmins === 1, `every counter in the race carries the same xmin (distinct: ${xmins})`);

  // Row order: the counters' heap order must not follow the voters' order.
  const byCtid = (
    await owner.query(
      "SELECT array_agg(candidate_id ORDER BY ctid) AS ids FROM vote_tallies WHERE position_id=$1",
      [position]
    )
  ).rows[0].ids;
  check(
    Array.isArray(byCtid) && byCtid.length === 2,
    `the race's choices are two counters, not one row per vote in voting order (rows: ${byCtid?.length ?? 0})`
  );
}

async function main() {
  const owner = new pg.Client({ connectionString: DATABASE_URL });
  const app = new pg.Client({ connectionString: APP_DATABASE_URL });
  await owner.connect();
  await app.connect();

  let A, B;
  try {
    const stale = await owner.query("DELETE FROM organizations WHERE slug LIKE $1", [
      `${SLUG_PREFIX}%`,
    ]);
    if (stale.rowCount) console.log(`removed ${stale.rowCount} leftover test org(s)`);

    A = await seedOrg(owner, "A");
    B = await seedOrg(owner, "B");
    console.log(`setup: org A=${A.orgId}  org B=${B.orgId}`);

    await checkConnectionRules(app);
    for (const table of TENANT_TABLES) await checkTable(owner, app, table, A, B);
    await checkBallotSecrecy(owner, app, A, B);
    await checkVoterLookupIndexes(app, A);
    await checkUpgrade(owner, DATABASE_URL, check);
  } finally {
    for (const o of [A, B]) {
      if (o) await owner.query("DELETE FROM organizations WHERE id=$1", [o.orgId]);
    }
    await owner.end();
    await app.end();
  }

  console.log(failures === 0 ? "\nALL RLS CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(describeDbError(err, DATABASE_URL));
  if (err?.stack && !Array.isArray(err.errors)) console.error(err.stack);
  process.exit(1);
});
