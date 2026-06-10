import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../lib/admin-session";
import { rateLimit } from "../../../lib/rate-limit";
import { withOrg } from "../../../lib/db";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";

/**
 * POST /api/vote — cast a vote. Server enforces eligibility, the poll window,
 * candidate validity, and one-vote-per-voter (DB unique constraint).
 *
 * Eligibility is generalized from the NSBE dues roster into the election's
 * eligibility_mode:
 *   - open                : no check-in required
 *   - pin / access_code   : a check-in row must exist for this device
 *   - roster_csv / email / sso : check-in must exist AND be verified
 * (Phase 5 fills in roster matching / magic links / SSO; this is the gate.)
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const electionId = typeof body?.election_id === "string" ? body.election_id.trim() : "";
  const positionId = typeof body?.position_id === "string" ? body.position_id.trim() : "";
  const candidateId = typeof body?.candidate_id === "string" ? body.candidate_id.trim() : "";
  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";

  if (!isUuid(electionId) || !isUuid(positionId) || !isUuid(candidateId)) {
    return NextResponse.json(
      { error: "election_id, position_id and candidate_id are required." },
      { status: 400 }
    );
  }
  // F8: exact 64-char lowercase hex device hash.
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "A valid device_hash is required." }, { status: 400 });
  }

  // F14: throttle per device.
  const limited = rateLimit(`vote:${deviceHash}`, 20, 10_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  try {
    return await withOrg(orgId, async (db) => {
      const { rows: eRows } = await db.query(
        `SELECT status, active_position_id, poll_expires_at, eligibility_mode
           FROM elections WHERE id = $1`,
        [electionId]
      );
      const election = eRows[0];
      if (!election) return NextResponse.json({ error: "Election not found" }, { status: 404 });

      // Poll window.
      if (election.status !== "voting") {
        return NextResponse.json({ error: "Voting is not open for this poll." }, { status: 403 });
      }
      if (election.active_position_id !== positionId) {
        return NextResponse.json({ error: "This race is not the active poll." }, { status: 403 });
      }
      if (
        election.poll_expires_at &&
        new Date(election.poll_expires_at).getTime() <= Date.now()
      ) {
        return NextResponse.json({ error: "Voting time has expired." }, { status: 403 });
      }

      // Eligibility gate.
      const mode = election.eligibility_mode;
      if (mode !== "open") {
        const { rows: cRows } = await db.query(
          "SELECT verified FROM checkins WHERE election_id=$1 AND device_hash=$2",
          [electionId, deviceHash]
        );
        const checkin = cRows[0];
        if (!checkin) {
          return NextResponse.json(
            { error: "Not checked in. Rejoin from the start screen.", code: "not_checked_in" },
            { status: 403 }
          );
        }
        const needsVerify = mode === "roster_csv" || mode === "email_magic_link" || mode === "sso_oidc";
        if (needsVerify && !checkin.verified) {
          return NextResponse.json(
            {
              error: "Your eligibility hasn't been confirmed yet. Wait for the host to verify you.",
              code: "verification_required",
            },
            { status: 403 }
          );
        }
      }

      // Candidate must belong to the active position and be active.
      const { rows: candRows } = await db.query(
        "SELECT 1 FROM candidates WHERE id=$1 AND position_id=$2 AND is_active=true",
        [candidateId, positionId]
      );
      if (!candRows[0]) {
        return NextResponse.json({ error: "Invalid candidate for this race." }, { status: 400 });
      }

      // Insert vote; voter_identity is the device hash for device-based modes.
      try {
        await db.query(
          `INSERT INTO votes (election_id, org_id, position_id, candidate_id, voter_identity)
           VALUES ($1, nullif(current_setting('app.current_org',true),'')::uuid, $2, $3, $4)`,
          [electionId, positionId, candidateId, deviceHash]
        );
      } catch (err) {
        if (err.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
        throw err;
      }
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** GET /api/vote?election_id=&position_id= — admin: live counts per candidate. */
export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const electionId = searchParams.get("election_id") || "";
  const positionId = searchParams.get("position_id") || "";
  if (!isUuid(electionId) || !isUuid(positionId)) {
    return NextResponse.json({ error: "election_id and position_id required" }, { status: 400 });
  }
  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  try {
    const { counts, total } = await withOrg(orgId, async (db) => {
      const { rows } = await db.query(
        "SELECT candidate_id, count(*)::int AS n FROM votes WHERE position_id=$1 GROUP BY candidate_id",
        [positionId]
      );
      const counts = {};
      let total = 0;
      for (const r of rows) {
        counts[r.candidate_id] = r.n;
        total += r.n;
      }
      return { counts, total };
    });
    return NextResponse.json({ counts, total });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
