import { NextResponse } from "next/server";
import { withOrg } from "../../../../lib/db";
import { authorizeElection } from "../../../../lib/auth";
import { resolveElectionOrg, isUuid } from "../../../../lib/api-helpers";
import { issueTicket } from "../../../../lib/realtime";
import { deviceRateLimit } from "../../../../lib/rate-limit";
import { isDeviceId, voterKey } from "../../../../lib/voter-identity";

/**
 * POST /api/realtime/ticket { election_id, device_hash? }
 *
 * A short-lived signed ticket to subscribe to one election's realtime room
 * (lib/realtime.js issueTicket; the gateway requires one in production).
 *   - An admin of the election's org (session cookie) gets an admin ticket.
 *   - A voter sends their device id and gets a voter ticket once that device
 *     is checked in.
 * Anyone else gets 401. Check-in and the eligibility refresh also return a
 * voter ticket, so the voter page rarely needs this route.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const raw = typeof body?.election_id === "string" ? body.election_id.trim() : "";
  if (!isUuid(raw)) return NextResponse.json({ error: "election_id required" }, { status: 400 });
  const electionId = raw.toLowerCase();

  try {
    const admin = await authorizeElection(req, electionId);
    if (admin) {
      return NextResponse.json({ ticket: issueTicket({ electionId, scope: "admin" }), scope: "admin" });
    }

    const deviceId = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
    if (!isDeviceId(deviceId)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = deviceRateLimit(`ticket:${deviceId}`, 30, 60_000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many requests. Slow down." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
      );
    }
    const orgId = await resolveElectionOrg(electionId);
    if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });
    const checkedIn = await withOrg(orgId, async (db) => {
      const { rows } = await db.query(
        "SELECT 1 FROM checkins WHERE election_id=$1 AND device_hash=$2",
        [electionId, voterKey(electionId, deviceId)]
      );
      return rows.length > 0;
    });
    if (!checkedIn) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ ticket: issueTicket({ electionId, scope: "voter" }), scope: "voter" });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
