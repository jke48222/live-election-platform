/**
 * Upgrade check for db/verify-rls.mjs: data written by the committed
 * single-tenant code survives migrations 0005 and later in a form the
 * current code accepts.
 *
 * In a scratch database it applies the migrations before 0005, writes rows
 * the way the old code did (raw device ids in checkins, in
 * eligible_voters.claimed_by_device and in one votes row per vote), applies
 * the rest, and checks that:
 *   - every stored identity is voterKey(election, device) and no raw device
 *     id is left anywhere;
 *   - a ballot from a device holding an access-code entry is carried over
 *     under entryRef(), the ref ballotRef() computes for that device now;
 *   - cast_ballot refuses a second vote from each voter who already voted;
 *   - the counts are unchanged.
 *
 * The owner needs CREATEDB (the Docker and CI owner is a superuser). Without
 * it the check is skipped with a note, not failed.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ballotRef, entryRef, voterKey } from "../lib/voter-identity.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const FIRST_NEW = "0005";

async function applyMigrations(client, files) {
  for (const f of files) {
    await client.query("BEGIN");
    try {
      await client.query(await readFile(join(MIGRATIONS_DIR, f), "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      err.message = `${f}: ${err.message}`;
      throw err;
    }
  }
}

const deviceId = () => randomBytes(32).toString("hex");

export async function checkUpgrade(owner, ownerUrl, check) {
  console.log("\nUpgrade from the committed schema");
  const dbName = `elections_upgrade_check_${randomBytes(4).toString("hex")}`;
  try {
    await owner.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    if (err.code === "42501") {
      console.log("  skip  the owner role cannot create a scratch database (needs CREATEDB)");
      return;
    }
    throw err;
  }

  const url = new URL(ownerUrl);
  url.pathname = `/${dbName}`;
  const db = new pg.Client({ connectionString: url.toString() });
  try {
    await db.connect();
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    await applyMigrations(db, files.filter((f) => f < FIRST_NEW));

    // Rows as the committed code wrote them.
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const org = (await one("INSERT INTO organizations (slug,name) VALUES ('up','Upgrade') RETURNING id")).id;
    const pinElection = (
      await one(
        "INSERT INTO elections (org_id,slug,title,eligibility_mode) VALUES ($1,'pin','PIN','pin') RETURNING id",
        [org]
      )
    ).id;
    const codeElection = (
      await one(
        `INSERT INTO elections (org_id,slug,title,eligibility_mode)
         VALUES ($1,'code','Codes','access_code') RETURNING id`,
        [org]
      )
    ).id;
    const position = async (election) =>
      (
        await one("INSERT INTO positions (election_id,org_id,title) VALUES ($1,$2,$3) RETURNING id", [
          election,
          org,
          `Race ${randomUUID().slice(0, 6)}`,
        ])
      ).id;
    const candidate = async (pos, name) =>
      (
        await one("INSERT INTO candidates (position_id,org_id,name) VALUES ($1,$2,$3) RETURNING id", [
          pos,
          org,
          name,
        ])
      ).id;
    const p1 = await position(pinElection);
    const c1 = await candidate(p1, "One");
    const c2 = await candidate(p1, "Two");
    const p2 = await position(codeElection);
    const c3 = await candidate(p2, "Three");

    const d1 = deviceId();
    const d2 = deviceId();
    const d3 = deviceId();
    const entry = (
      await one(
        `INSERT INTO eligible_voters (election_id,org_id,identifier,token,used_at,claimed_by_device)
         VALUES ($1,$2,'code-1','ABC123',now(),$3) RETURNING id`,
        [codeElection, org, d3]
      )
    ).id;
    for (const [election, device, name] of [
      [pinElection, d1, "Voter One"],
      [pinElection, d2, "Voter Two"],
      [codeElection, d3, "Voter Three"],
    ]) {
      await db.query(
        "INSERT INTO checkins (election_id,org_id,device_hash,display_name,verified) VALUES ($1,$2,$3,$4,true)",
        [election, org, device, name]
      );
    }
    for (const [election, pos, cand, device] of [
      [pinElection, p1, c1, d1],
      [pinElection, p1, c2, d2],
      [codeElection, p2, c3, d3],
    ]) {
      await db.query(
        `INSERT INTO votes (election_id,org_id,position_id,candidate_id,voter_identity)
         VALUES ($1,$2,$3,$4,$5)`,
        [election, org, pos, cand, device]
      );
    }

    await applyMigrations(db, files.filter((f) => f >= FIRST_NEW));

    const k1 = voterKey(pinElection, d1);
    const k2 = voterKey(pinElection, d2);
    const k3 = voterKey(codeElection, d3);

    const checkins = (await db.query("SELECT device_hash FROM checkins ORDER BY display_name")).rows.map(
      (r) => r.device_hash
    );
    check(
      checkins.join() === [k1, k3, k2].join(),
      "check-ins are stored under voterKey(), so /api/vote and /api/checkin still find them"
    );
    const claimed = (await one("SELECT claimed_by_device FROM eligible_voters WHERE id=$1", [entry]))
      .claimed_by_device;
    check(claimed === k3, "a claimed access code is stored under voterKey()");

    const refs = async (pos) =>
      (await db.query("SELECT voter_ref FROM ballots_cast WHERE position_id=$1 ORDER BY voter_ref", [pos])).rows
        .map((r) => r.voter_ref)
        .join();
    check((await refs(p1)) === [k1, k2].sort().join(), "ballots in a PIN election are carried over under voterKey()");
    const e3 = entryRef(codeElection, "code-1");
    check((await refs(p2)) === e3, "a ballot from a device holding a code is carried over under its entry");

    const raw = (
      await one(
        `SELECT (SELECT count(*) FROM checkins WHERE device_hash = ANY($1))
              + (SELECT count(*) FROM eligible_voters WHERE claimed_by_device = ANY($1))
              + (SELECT count(*) FROM ballots_cast WHERE voter_ref = ANY($1)) AS n`,
        [[d1, d2, d3]]
      )
    ).n;
    check(Number(raw) === 0, "no raw device id is left in the database");

    // What /api/vote does now for each of those voters.
    await db.query("BEGIN");
    let again;
    try {
      await db.query("SELECT set_config('app.current_org',$1,true)", [org]);
      const ref3 = await ballotRef(db, codeElection, "access_code", k3);
      const cast = async (e, p, c, ref) =>
        (await db.query("SELECT cast_ballot($1,$2,$3,$4) AS ok", [e, p, c, ref])).rows[0].ok;
      again = {
        ref3,
        v1: await cast(pinElection, p1, c2, k1),
        v2: await cast(pinElection, p1, c1, k2),
        v3: await cast(codeElection, p2, c3, ref3),
      };
    } finally {
      await db.query("ROLLBACK");
    }
    check(again.ref3 === e3, "ballotRef() finds the carried-over entry for the code voter");
    check(
      again.v1 === false && again.v2 === false && again.v3 === false,
      "voters who voted before the upgrade cannot vote again in the same race"
    );

    const tallies = (
      await db.query("SELECT candidate_id, n FROM vote_tallies ORDER BY candidate_id")
    ).rows;
    const n = Object.fromEntries(tallies.map((r) => [r.candidate_id, r.n]));
    check(n[c1] === 1 && n[c2] === 1 && n[c3] === 1, "every vote cast before the upgrade is still counted");
  } finally {
    await db.end().catch(() => {});
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  }
}
