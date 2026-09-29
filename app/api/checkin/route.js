import { NextResponse } from "next/server";
import { clientIpFromReq, deviceRateLimit, rateLimit } from "../../../lib/rate-limit";
import { withOrg } from "../../../lib/db";
import { emit, issueTicket } from "../../../lib/realtime";
import { authorizeElection } from "../../../lib/auth";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";
import {
  resolveEligibility,
  nameIsIdentity,
  pinMatches,
  releaseClaims,
} from "../../../lib/eligibility";
import { isDeviceId, voterKey } from "../../../lib/voter-identity";

const MAX_NAME = 255;

/** Normalize a display name for same-name duplicate detection. */
function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function tooMany(retryAfter, error = "Too many check-in attempts. Try again shortly.") {
  return NextResponse.json(
    { error },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/** A voter-scope realtime ticket, or undefined when none can be issued. */
function voterTicket(electionId) {
  try {
    return issueTicket({ electionId, scope: "voter" });
  } catch (err) {
    console.error("[checkin] could not issue a realtime ticket:", err.message);
    return undefined;
  }
}

/**
 * POST: voter checks in for an election (PIN, roster, email or code).
 *
 * `device_hash` is the voter's secret device id. The server stores only
 * voterKey(election, device) and returns it as `device_tag`, which is also
 * what check-in realtime events carry.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { election_id: rawElectionId, display_name, device_hash: deviceId, pin, code, email } = body || {};

  if (!isUuid(rawElectionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const electionId = rawElectionId.toLowerCase();
  const name = typeof display_name === "string" ? display_name.trim() : "";
  if (!name || name.length > MAX_NAME) {
    return NextResponse.json({ error: "Name is required (max 255 characters)." }, { status: 400 });
  }
  if (!isDeviceId(deviceId)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }

  // A room on campus Wi-Fi shares one public IP, so the per-IP ceiling is
  // high, and each device gets its own limit per election.
  const ip = clientIpFromReq(req);
  if (ip) {
    const perIp = rateLimit(`checkin-ip:${ip}`, 300, 60_000);
    if (!perIp.ok) return tooMany(perIp.retryAfter);
  }
  const perDevice = deviceRateLimit(`checkin:${electionId}:${deviceId}`, 10, 60_000);
  if (!perDevice.ok) return tooMany(perDevice.retryAfter);

  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  const key = voterKey(electionId, deviceId);

  try {
    return await withOrg(orgId, async (db) => {
      // One check-in at a time per election, so the duplicate-name check and
      // the roster, email or code claim cannot race.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `checkin:${electionId}`,
      ]);

      const { rows: eRows } = await db.query(
        "SELECT eligibility_mode, pin FROM elections WHERE id=$1",
        [electionId]
      );
      const election = eRows[0];
      if (!election) return NextResponse.json({ error: "Election not found" }, { status: 404 });

      // Fails closed: a PIN election with no PIN set admits nobody.
      if (election.eligibility_mode === "pin" && !pinMatches(election.pin, pin)) {
        // The mode is public (GET /api/election returns it), and a voter page
        // that is still showing an older form uses it to switch fields.
        return NextResponse.json(
          { error: "Invalid room PIN", eligibility_mode: election.eligibility_mode },
          { status: 401 }
        );
      }

      // A duplicate display name is only a conflict when the name IS the
      // voter's identity (pin/open/roster). For codes/emails, identity is the
      // code/email, so two voters may legitimately share a display name.
      if (nameIsIdentity(election.eligibility_mode)) {
        const nk = nameKey(name);
        const { rows: dupes } = await db.query(
          "SELECT display_name FROM checkins WHERE election_id=$1 AND device_hash<>$2",
          [electionId, key]
        );
        if (dupes.some((r) => nameKey(r.display_name) === nk)) {
          return NextResponse.json(
            { error: "This name is already checked in on another device." },
            { status: 409 }
          );
        }
      }

      // Roster, email and code modes claim an eligible_voters entry here.
      const elig = await resolveEligibility(
        db,
        { id: electionId, eligibility_mode: election.eligibility_mode },
        { displayName: name, email, code, voterKey: key }
      );
      if (!elig.ok) {
        return NextResponse.json(
          { error: elig.error, code: elig.code, eligibility_mode: election.eligibility_mode },
          { status: elig.status || 403 }
        );
      }
      const verified = elig.verified;
      // A new name resets verification; the same name keeps a host's verify
      // and picks up a roster entry added since.
      const orgExpr = "nullif(current_setting('app.current_org',true),'')::uuid";
      await db.query(
        `INSERT INTO checkins (election_id, org_id, device_hash, display_name, verified)
           VALUES ($1, ${orgExpr}, $2, $3, $4)
         ON CONFLICT (election_id, device_hash) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               verified = CASE WHEN checkins.display_name <> EXCLUDED.display_name
                               THEN $4 ELSE (checkins.verified OR $4) END,
               updated_at = now()`,
        [electionId, key, name, verified]
      );
      // Tells the host's console to refresh its check-in list. No identity.
      // Admin sockets only: voter pages ignore it, and sending it to every
      // phone in the room costs one frame per voter per check-in.
      await emit(db, electionId, "checkin_created", { verified }, { audience: "admin" });

      return NextResponse.json({
        ok: true,
        verified,
        device_tag: key,
        ticket: voterTicket(electionId),
      });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Admin wrapper: RBAC authorize + RLS scope. */
async function withAdminElection(req, body, fn) {
  const raw =
    (body && typeof body.election_id === "string" && body.election_id.trim()) ||
    new URL(req.url).searchParams.get("election_id") ||
    "";
  if (!isUuid(raw)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const electionId = raw.toLowerCase();
  const auth = await authorizeElection(req, electionId);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await withOrg(auth.orgId, (db) => fn(db, electionId));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Which check-in an admin request means: `id` (the check-in row id) or
 * `device_hash` (the stored key from GET). A raw device id is also accepted
 * and hashed, for scripts that know it. Returns SQL and params, or null.
 */
function targetCheckin(body, electionId) {
  if (isUuid(body?.id)) {
    return { where: "election_id=$1 AND id=$2", params: [electionId, body.id] };
  }
  const given = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!isDeviceId(given)) return null;
  return {
    where: "election_id=$1 AND device_hash IN ($2, $3)",
    params: [electionId, given, voterKey(electionId, given)],
  };
}

/**
 * GET: admin: list check-ins for an election. `device_hash` here is the
 * stored key, not the voter's device id, so the list holds no credential.
 */
export async function GET(req) {
  return withAdminElection(req, null, async (db, electionId) => {
    const { rows } = await db.query(
      `SELECT id, device_hash, display_name, verified, created_at, updated_at
         FROM checkins WHERE election_id=$1 ORDER BY lower(display_name)`,
      [electionId]
    );
    const keyCounts = new Map();
    for (const r of rows) {
      const k = nameKey(r.display_name);
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    const checkins = rows.map((r) => ({
      ...r,
      name_duplicate: (keyCounts.get(nameKey(r.display_name)) || 0) > 1,
    }));
    return NextResponse.json({ checkins });
  });
}

/**
 * PATCH { election_id, id | device_hash }: admin: verify a voter.
 */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db, electionId) => {
    const target = targetCheckin(body, electionId);
    if (!target) return NextResponse.json({ error: "id or device_hash required" }, { status: 400 });
    const { rows } = await db.query(
      `UPDATE checkins SET verified=true, updated_at=now() WHERE ${target.where} RETURNING device_hash`,
      target.params
    );
    if (!rows.length) {
      return NextResponse.json({ error: "No check-in found for this device" }, { status: 404 });
    }
    for (const r of rows) {
      await emit(db, electionId, "checkin_verified", { device_tag: r.device_hash });
    }
    return NextResponse.json({ ok: true });
  });
}

/**
 * DELETE { election_id, id | device_hash }: admin: remove a check-in. Also
 * releases any roster, email or code entry the device held, so the person
 * can check in again on another phone. Ballots already cast stay counted
 * under that entry, so this cannot give anyone a second vote in a race.
 */
export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db, electionId) => {
    const target = targetCheckin(body, electionId);
    if (!target) return NextResponse.json({ error: "id or device_hash required" }, { status: 400 });
    const { rows } = await db.query(
      `DELETE FROM checkins WHERE ${target.where} RETURNING device_hash`,
      target.params
    );
    for (const r of rows) {
      await releaseClaims(db, electionId, r.device_hash);
      await emit(db, electionId, "checkin_revoked", { device_tag: r.device_hash });
    }
    return NextResponse.json({ ok: true });
  });
}
