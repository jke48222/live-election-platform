import { NextResponse } from "next/server";
import { getOrgBySlug, withOrg } from "../../../lib/db";
import { emit } from "../../../lib/realtime";

/**
 * GET /api/election?org=<slug>&election=<slug>
 *
 * Public voter read — replaces the browser's direct Supabase reads of
 * election_state + roles. Returns the election's live state and its positions.
 * Candidates are fetched per-position via /api/candidates when a poll launches.
 *
 * server_now is the server's clock at the time of the read, so clients time
 * the poll against the server instead of their own clock.
 *
 * A poll whose time has run out is locked here, on read, so the room closes
 * on time even when no admin tab is open to send the lock. The update only
 * matches a still-voting, expired poll, so it runs at most once per poll.
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("org");
  const electionSlug = searchParams.get("election");
  if (!orgSlug || !electionSlug) {
    return NextResponse.json({ error: "org and election are required" }, { status: 400 });
  }

  const org = await getOrgBySlug(orgSlug);
  if (!org) return NextResponse.json({ error: "Unknown organization" }, { status: 404 });

  try {
    const result = await withOrg(org.id, async (db) => {
      const { rows: eRows } = await db.query(
        `SELECT id, title, description, mode, status, active_position_id,
                poll_expires_at, opens_at, closes_at, eligibility_mode
           FROM elections WHERE slug = $1`,
        [electionSlug]
      );
      const election = eRows[0];
      if (!election) return null;

      if (
        election.status === "voting" &&
        election.poll_expires_at &&
        new Date(election.poll_expires_at).getTime() <= Date.now()
      ) {
        const { rowCount } = await db.query(
          `UPDATE elections SET status='locked', updated_at=now()
            WHERE id=$1 AND status='voting' AND poll_expires_at <= now()`,
          [election.id]
        );
        if (rowCount) {
          election.status = "locked";
          await emit(db, election.id, "state_change", {
            status: "locked",
            active_position_id: election.active_position_id,
            poll_expires_at: election.poll_expires_at,
            server_now: new Date().toISOString(),
          });
        }
      }

      const { rows: positions } = await db.query(
        `SELECT id, title, sort_order, max_winners, is_completed
           FROM positions WHERE election_id = $1 ORDER BY sort_order`,
        [election.id]
      );
      return { election, positions };
    });

    if (!result) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

    return NextResponse.json({
      org: { slug: org.slug, name: org.name, branding: org.branding },
      ...result,
      server_now: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
