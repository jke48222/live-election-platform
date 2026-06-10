import { NextResponse } from "next/server";
import { withOrg } from "../../../lib/db";
import { emit } from "../../../lib/realtime";
import { authorizeElection } from "../../../lib/auth";
import { isUuid } from "../../../lib/api-helpers";

/**
 * Position (ballot office) management for the election builder. All operations
 * require an admin session for the election's org (authorizeElection) and run
 * inside that org's RLS scope. Structural edits are only allowed while the
 * election is idle (draft/waiting, no active poll) so a live ballot can't
 * change underneath voters.
 */

async function authorize(req, electionId) {
  if (!isUuid(electionId)) return { error: "election_id required", status: 400 };
  const auth = await authorizeElection(req, electionId);
  if (!auth) return { error: "Unauthorized", status: 401 };
  return auth;
}

/** True when the election can be structurally edited. */
function editable(election) {
  return (
    (election.status === "draft" || election.status === "waiting") &&
    !election.active_position_id
  );
}

/** GET /api/positions?election_id= — positions with their candidates (admin). */
export async function GET(req) {
  const electionId = new URL(req.url).searchParams.get("election_id") || "";
  const auth = await authorize(req, electionId);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const positions = await withOrg(auth.orgId, async (db) => {
      const { rows: pos } = await db.query(
        `SELECT id, title, sort_order, max_winners, is_completed
           FROM positions WHERE election_id = $1 ORDER BY sort_order`,
        [electionId]
      );
      const { rows: cands } = await db.query(
        `SELECT c.id, c.position_id, c.name, c.bio, c.is_active, c.sort_order
           FROM candidates c JOIN positions p ON p.id = c.position_id
          WHERE p.election_id = $1 ORDER BY c.sort_order, c.name`,
        [electionId]
      );
      const byPos = new Map(pos.map((p) => [p.id, { ...p, candidates: [] }]));
      for (const c of cands) byPos.get(c.position_id)?.candidates.push(c);
      return [...byPos.values()];
    });
    return NextResponse.json({ positions });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** POST /api/positions { election_id, title, max_winners? } — add a position. */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const auth = await authorize(req, body?.election_id);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const maxWinners = Math.max(1, Math.min(50, Number(body?.max_winners) || 1));
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });
  if (title.length > 120) return NextResponse.json({ error: "Title too long." }, { status: 400 });

  try {
    const result = await withOrg(auth.orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT status, active_position_id FROM elections WHERE id = $1",
        [body.election_id]
      );
      if (!eRows[0]) return { error: "Election not found", status: 404 };
      if (!editable(eRows[0])) return { error: "Finish the current poll before editing the ballot.", status: 409 };

      const { rows: ord } = await db.query(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM positions WHERE election_id = $1",
        [body.election_id]
      );
      const { rows } = await db.query(
        `INSERT INTO positions (election_id, org_id, title, sort_order, max_winners)
         VALUES ($1, nullif(current_setting('app.current_org',true),'')::uuid, $2, $3, $4)
         RETURNING id, title, sort_order, max_winners, is_completed`,
        [body.election_id, title, ord[0].next, maxWinners]
      );
      return { position: { ...rows[0], candidates: [] } };
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** PATCH /api/positions { election_id, id, title?, max_winners?, move? } */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const auth = await authorize(req, body?.election_id);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!isUuid(body?.id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const result = await withOrg(auth.orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT status, active_position_id FROM elections WHERE id = $1",
        [body.election_id]
      );
      if (!eRows[0]) return { error: "Election not found", status: 404 };
      if (!editable(eRows[0])) return { error: "Finish the current poll before editing the ballot.", status: 409 };

      // Reorder: swap sort_order with the neighbor in the given direction.
      if (body.move === "up" || body.move === "down") {
        const { rows: cur } = await db.query(
          "SELECT id, sort_order FROM positions WHERE id = $1 AND election_id = $2",
          [body.id, body.election_id]
        );
        if (!cur[0]) return { error: "Position not found", status: 404 };
        const op = body.move === "up" ? "<" : ">";
        const dir = body.move === "up" ? "DESC" : "ASC";
        const { rows: nb } = await db.query(
          `SELECT id, sort_order FROM positions
            WHERE election_id = $1 AND sort_order ${op} $2 ORDER BY sort_order ${dir} LIMIT 1`,
          [body.election_id, cur[0].sort_order]
        );
        if (nb[0]) {
          await db.query("UPDATE positions SET sort_order = $1 WHERE id = $2", [nb[0].sort_order, cur[0].id]);
          await db.query("UPDATE positions SET sort_order = $1 WHERE id = $2", [cur[0].sort_order, nb[0].id]);
        }
        return { ok: true };
      }

      const fields = [];
      const params = [];
      if (typeof body.title === "string" && body.title.trim()) {
        params.push(body.title.trim());
        fields.push(`title = $${params.length}`);
      }
      if (body.max_winners != null) {
        params.push(Math.max(1, Math.min(50, Number(body.max_winners) || 1)));
        fields.push(`max_winners = $${params.length}`);
      }
      if (fields.length === 0) return { error: "Nothing to update", status: 400 };
      params.push(body.id, body.election_id);
      const { rowCount } = await db.query(
        `UPDATE positions SET ${fields.join(", ")} WHERE id = $${params.length - 1} AND election_id = $${params.length}`,
        params
      );
      if (!rowCount) return { error: "Position not found", status: 404 };
      return { ok: true };
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** DELETE /api/positions { election_id, id } — remove a position (and its votes). */
export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const auth = await authorize(req, body?.election_id);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!isUuid(body?.id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const result = await withOrg(auth.orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT status, active_position_id FROM elections WHERE id = $1",
        [body.election_id]
      );
      if (!eRows[0]) return { error: "Election not found", status: 404 };
      if (!editable(eRows[0])) return { error: "Finish the current poll before editing the ballot.", status: 409 };
      const { rowCount } = await db.query(
        "DELETE FROM positions WHERE id = $1 AND election_id = $2",
        [body.id, body.election_id]
      );
      if (!rowCount) return { error: "Position not found", status: 404 };
      return { ok: true };
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
