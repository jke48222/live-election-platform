import { NextResponse } from "next/server";
import { deviceRateLimit } from "../../../lib/rate-limit";
import { withOrg } from "../../../lib/db";
import { authorizeElection } from "../../../lib/auth";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";
import { ballotRef, isDeviceId, voterKey } from "../../../lib/voter-identity";

/**
 * POST /api/vote: cast a vote. Server enforces eligibility, the poll window,
 * candidate validity, and one vote per voter per race.
 *
 * Eligibility comes from the election's eligibility_mode:
 *   - open                : no check-in required
 *   - pin / access_code   : a check-in row must exist for this device
 *   - roster_csv / email / sso : check-in must exist AND be verified
 *
 * `device_hash` is the voter's secret device id. The ballot is recorded by
 * cast_ballot() (db/migrations/0007) under ballotRef(): the claimed roster,
 * email or access-code entry in those modes, otherwise the device's key. So
 * one listed person gets one ballot per race however many devices they use.
 *
 * The election row is read FOR SHARE. /api/state takes it FOR UPDATE, so a
 * vote either commits before a lock, finalize or clear-and-restart, or waits
 * and then sees the new state. An old-round vote cannot land in a runoff.
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
  const deviceId = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";

  if (!isUuid(electionId) || !isUuid(positionId) || !isUuid(candidateId)) {
    return NextResponse.json(
      { error: "election_id, position_id and candidate_id are required." },
      { status: 400 }
    );
  }
  if (!isDeviceId(deviceId)) {
    return NextResponse.json({ error: "A valid device_hash is required." }, { status: 400 });
  }

  // Throttle per device. Kept apart from the IP and account limits, so a
  // flood of made-up device ids cannot push those out.
  const limited = deviceRateLimit(`vote:${deviceId}`, 20, 10_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });
  const key = voterKey(electionId, deviceId);

  try {
    return await withOrg(orgId, async (db) => {
      const { rows: eRows } = await db.query(
        `SELECT status, active_position_id, poll_expires_at, eligibility_mode
           FROM elections WHERE id = $1 FOR SHARE`,
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
          [electionId, key]
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

      const ref = await ballotRef(db, electionId, mode, key);
      // Every email or code check-in holds an entry. One without (its entry
      // was deleted) must check in again rather than vote as the device.
      if ((mode === "email_magic_link" || mode === "access_code") && ref === key) {
        return NextResponse.json(
          { error: "Not checked in. Rejoin from the start screen.", code: "not_checked_in" },
          { status: 403 }
        );
      }
      const { rows: cast } = await db.query("SELECT cast_ballot($1, $2, $3, $4) AS recorded", [
        electionId,
        positionId,
        candidateId,
        ref,
      ]);
      if (!cast[0]?.recorded) return NextResponse.json({ ok: true, duplicate: true, code: "already_voted" });
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** GET /api/vote?election_id=&position_id=: admin: live counts per candidate. */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const electionId = searchParams.get("election_id") || "";
  const positionId = searchParams.get("position_id") || "";
  if (!isUuid(electionId) || !isUuid(positionId)) {
    return NextResponse.json({ error: "election_id and position_id required" }, { status: 400 });
  }
  const auth = await authorizeElection(req, electionId);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { counts, total } = await withOrg(auth.orgId, async (db) => {
      const { rows } = await db.query(
        `SELECT candidate_id, count(*)::int AS n FROM votes
          WHERE position_id=$1 AND election_id=$2 GROUP BY candidate_id`,
        [positionId, electionId]
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
