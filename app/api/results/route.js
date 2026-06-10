import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../lib/admin-session";
import { withOrg } from "../../../lib/db";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";

/**
 * GET /api/results?election_id=[&position_id=]
 *   - with position_id : winner row for that single position
 *   - without          : winner rows for every completed position
 *
 * Plurality among active candidates (preserves the original tie semantics:
 * leaders = all candidates sharing the top count). Multi-seat tallies for
 * positions with max_winners > 1 are a later refinement.
 */
async function winnerRow(db, position) {
  const { rows: cands } = await db.query(
    "SELECT id, name FROM candidates WHERE position_id=$1 AND is_active=true",
    [position.id]
  );
  const { rows: voteRows } = await db.query(
    "SELECT candidate_id, count(*)::int AS n FROM votes WHERE position_id=$1 GROUP BY candidate_id",
    [position.id]
  );
  const counts = {};
  let total = 0;
  for (const r of voteRows) {
    counts[r.candidate_id] = r.n;
    total += r.n;
  }

  const base = {
    position_id: position.id,
    title: position.title,
    sort_order: position.sort_order,
    max_winners: position.max_winners,
    is_completed: !!position.is_completed,
    total_votes: total,
  };

  if (cands.length === 0) {
    return { ...base, names: [], display: "—", is_tie: false, vote_count: 0 };
  }
  let max = 0;
  for (const c of cands) max = Math.max(max, counts[c.id] || 0);
  if (max === 0) {
    return { ...base, names: [], display: "No votes", is_tie: false, vote_count: 0 };
  }
  const leaders = cands.filter((c) => (counts[c.id] || 0) === max);
  return {
    ...base,
    names: leaders.map((c) => c.name),
    display: leaders.map((c) => c.name).join(" · "),
    is_tie: leaders.length > 1,
    vote_count: max,
  };
}

export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const electionId = searchParams.get("election_id") || "";
  const positionId = searchParams.get("position_id");
  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  try {
    return await withOrg(orgId, async (db) => {
      if (positionId) {
        if (!isUuid(positionId)) {
          return NextResponse.json({ error: "Invalid position_id" }, { status: 400 });
        }
        const { rows } = await db.query(
          "SELECT id, title, sort_order, max_winners, is_completed FROM positions WHERE id=$1 AND election_id=$2",
          [positionId, electionId]
        );
        if (!rows[0]) return NextResponse.json({ error: "Position not found" }, { status: 404 });
        return NextResponse.json({ winner: await winnerRow(db, rows[0]) });
      }

      const { rows: positions } = await db.query(
        `SELECT id, title, sort_order, max_winners, is_completed FROM positions
           WHERE election_id=$1 AND is_completed=true ORDER BY sort_order`,
        [electionId]
      );
      const winners = [];
      for (const p of positions) winners.push(await winnerRow(db, p));
      return NextResponse.json({ winners });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
