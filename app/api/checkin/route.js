import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../lib/admin-session";
import { clientIpFromReq, rateLimit } from "../../../lib/rate-limit";
import { withOrg } from "../../../lib/db";
import { emit } from "../../../lib/realtime";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";

const MAX_NAME = 255;

/** Normalize a display name for same-name duplicate detection. */
function nameKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Modes where a voter must be verified before they can vote. */
function needsVerification(mode) {
  return mode === "roster_csv" || mode === "email_magic_link" || mode === "sso_oidc";
}

/** POST — voter registers identity for an election (PIN-gated when applicable). */
export async function POST(req) {
  const ip = clientIpFromReq(req);
  const limited = rateLimit(`checkin:${ip}`, 20, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many check-in attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { election_id: electionId, display_name, device_hash: deviceHash, pin } = body || {};

  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const name = typeof display_name === "string" ? display_name.trim() : "";
  if (!name || name.length > MAX_NAME) {
    return NextResponse.json({ error: "Name is required (max 255 characters)." }, { status: 400 });
  }
  if (typeof deviceHash !== "string" || !/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }

  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  try {
    return await withOrg(orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT eligibility_mode, pin FROM elections WHERE id=$1",
        [electionId]
      );
      const election = eRows[0];
      if (!election) return NextResponse.json({ error: "Election not found" }, { status: 404 });

      if (election.eligibility_mode === "pin" && pin !== election.pin) {
        return NextResponse.json({ error: "Invalid room PIN" }, { status: 401 });
      }

      // Block the same name held on a different device in this election.
      const key = nameKey(name);
      const { rows: dupes } = await db.query(
        "SELECT device_hash, display_name FROM checkins WHERE election_id=$1 AND device_hash<>$2",
        [electionId, deviceHash]
      );
      if (dupes.some((r) => nameKey(r.display_name) === key)) {
        return NextResponse.json(
          { error: "This name is already checked in on another device." },
          { status: 409 }
        );
      }

      const verified = !needsVerification(election.eligibility_mode);
      // Re-checking in with a new name on the same device resets verification.
      const orgExpr = "nullif(current_setting('app.current_org',true),'')::uuid";
      await db.query(
        `INSERT INTO checkins (election_id, org_id, device_hash, display_name, verified)
           VALUES ($1, ${orgExpr}, $2, $3, $4)
         ON CONFLICT (election_id, device_hash) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               verified = CASE WHEN checkins.display_name <> EXCLUDED.display_name
                               THEN $4 ELSE checkins.verified END,
               updated_at = now()`,
        [electionId, deviceHash, name, verified]
      );

      return NextResponse.json({ ok: true, verified });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Admin wrapper: auth + resolve election org + RLS scope. */
async function withAdminElection(req, body, fn) {
  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const electionId =
    (body && typeof body.election_id === "string" && body.election_id.trim()) ||
    new URL(req.url).searchParams.get("election_id") ||
    "";
  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });
  try {
    return await withOrg(orgId, (db) => fn(db, electionId));
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** GET — admin: list check-ins for an election. */
export async function GET(req) {
  return withAdminElection(req, null, async (db, electionId) => {
    const { rows } = await db.query(
      `SELECT device_hash, display_name, verified, created_at, updated_at
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

/** PATCH — admin: verify a voter (e.g. manual eligibility confirmation). */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db, electionId) => {
    const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
    if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
      return NextResponse.json({ error: "device_hash required" }, { status: 400 });
    }
    const { rowCount } = await db.query(
      "UPDATE checkins SET verified=true, updated_at=now() WHERE election_id=$1 AND device_hash=$2",
      [electionId, deviceHash]
    );
    if (!rowCount) {
      return NextResponse.json({ error: "No check-in found for this device" }, { status: 404 });
    }
    await emit(db, electionId, "checkin_verified", { device_hash: deviceHash });
    return NextResponse.json({ ok: true });
  });
}

/** DELETE — admin: remove a check-in. */
export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db, electionId) => {
    const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
    if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
      return NextResponse.json({ error: "device_hash required" }, { status: 400 });
    }
    const { rowCount } = await db.query(
      "DELETE FROM checkins WHERE election_id=$1 AND device_hash=$2",
      [electionId, deviceHash]
    );
    if (rowCount) await emit(db, electionId, "checkin_revoked", { device_hash: deviceHash });
    return NextResponse.json({ ok: true });
  });
}
