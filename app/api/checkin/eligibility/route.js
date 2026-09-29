import { NextResponse } from "next/server";
import { withOrg } from "../../../../lib/db";
import { resolveElectionOrg, isUuid } from "../../../../lib/api-helpers";
import { issueTicket } from "../../../../lib/realtime";
import { deviceRateLimit } from "../../../../lib/rate-limit";
import { ballotRef, isDeviceId, voterKey } from "../../../../lib/voter-identity";

/**
 * POST /api/checkin/eligibility: voter refreshes their own status after a
 * realtime reconnect / tab focus (device_hash is the voter's secret device
 * id; no PIN).
 *
 * Returns whether this device is checked in and verified for the election,
 * and which positions it has a ballot on record for. The voter screen trusts
 * voted_position_ids over its own cache, so a vote deleted by Clear & Restart
 * or a reset reopens the ballot even if the purge event never arrived.
 * A checked-in device also gets a fresh realtime `ticket` and its
 * `device_tag`.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawElectionId = typeof body?.election_id === "string" ? body.election_id.trim() : "";
  const deviceId = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!isUuid(rawElectionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  if (!isDeviceId(deviceId)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }
  const electionId = rawElectionId.toLowerCase();

  const limited = deviceRateLimit(`eligibility:${deviceId}`, 60, 60_000);
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
    const result = await withOrg(orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT eligibility_mode FROM elections WHERE id=$1",
        [electionId]
      );
      const { rows } = await db.query(
        "SELECT verified FROM checkins WHERE election_id=$1 AND device_hash=$2",
        [electionId, key]
      );
      const ref = await ballotRef(db, electionId, eRows[0]?.eligibility_mode, key);
      const { rows: voted } = await db.query(
        "SELECT DISTINCT position_id FROM ballots_cast WHERE election_id=$1 AND voter_ref=$2",
        [electionId, ref]
      );
      return { checkin: rows[0], voted: voted.map((r) => r.position_id) };
    });

    let ticket;
    if (result.checkin) {
      try {
        ticket = issueTicket({ electionId, scope: "voter" });
      } catch (err) {
        console.error("[eligibility] could not issue a realtime ticket:", err.message);
      }
    }
    return NextResponse.json({
      checked_in: !!result.checkin,
      verified: result.checkin ? result.checkin.verified : false,
      voted_position_ids: result.voted,
      device_tag: key,
      ticket,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
