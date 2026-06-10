import { NextResponse } from "next/server";
import { withOrg } from "../../../../lib/db";
import { resolveElectionOrg, isUuid } from "../../../../lib/api-helpers";

/**
 * POST /api/checkin/eligibility — voter refreshes their own status after a
 * realtime reconnect / tab focus (device_hash acts as the secret; no PIN).
 * Returns whether this device is checked in and verified for the election.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const electionId = typeof body?.election_id === "string" ? body.election_id.trim() : "";
  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }

  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  try {
    const result = await withOrg(orgId, async (db) => {
      const { rows } = await db.query(
        "SELECT verified FROM checkins WHERE election_id=$1 AND device_hash=$2",
        [electionId, deviceHash]
      );
      return rows[0];
    });
    if (!result) return NextResponse.json({ checked_in: false, verified: false });
    return NextResponse.json({ checked_in: true, verified: result.verified });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
