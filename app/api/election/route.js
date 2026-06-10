import { NextResponse } from "next/server";
import { getOrgBySlug, withOrg } from "../../../lib/db";

/**
 * GET /api/election?org=<slug>&election=<slug>
 *
 * Public voter read — replaces the browser's direct Supabase reads of
 * election_state + roles. Returns the election's live state and its positions.
 * Candidates are fetched per-position via /api/candidates when a poll launches.
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
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
