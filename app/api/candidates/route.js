import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../lib/admin-session";
import { withOrg } from "../../../lib/db";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";

/**
 * GET /api/candidates?election_id=&position_id=
 *   - voters (no session): active candidates only.
 *   - admins (valid session): ALL candidates incl. inactive + is_active flag,
 *     so the pre-poll checklist can toggle them back on.
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const electionId = searchParams.get("election_id") || "";
  const positionId = searchParams.get("position_id") || "";
  if (!isUuid(electionId) || !isUuid(positionId)) {
    return NextResponse.json({ error: "election_id and position_id required" }, { status: 400 });
  }
  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) return NextResponse.json({ error: "Unknown election" }, { status: 404 });

  const admin = isAdminRequest(req, null);
  try {
    const candidates = await withOrg(orgId, async (db) => {
      const activeFilter = admin ? "" : "AND c.is_active = true";
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.bio, c.photo_url, c.is_active, c.sort_order
           FROM candidates c JOIN positions p ON p.id = c.position_id
           WHERE c.position_id = $1 AND p.election_id = $2 ${activeFilter}
           ORDER BY c.sort_order, c.name`,
        [positionId, electionId]
      );
      return rows;
    });
    return NextResponse.json({ candidates });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Admin: resolve org + run inside its RLS scope. */
async function withAdminElection(req, body, fn) {
  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const electionId = typeof body?.election_id === "string" ? body.election_id.trim() : "";
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

/** POST — add a floor nomination / write-in candidate. */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db, electionId) => {
    const positionId = typeof body?.position_id === "string" ? body.position_id.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!isUuid(positionId) || !name) {
      return NextResponse.json({ error: "position_id and name required" }, { status: 400 });
    }
    if (name.length > 255) {
      return NextResponse.json({ error: "Name too long (max 255)" }, { status: 400 });
    }
    // Position must belong to this election (defense in depth alongside RLS).
    const { rows: pr } = await db.query(
      "SELECT 1 FROM positions WHERE id=$1 AND election_id=$2",
      [positionId, electionId]
    );
    if (!pr[0]) return NextResponse.json({ error: "Unknown position" }, { status: 404 });

    const { rows } = await db.query(
      `INSERT INTO candidates (position_id, org_id, name, is_active)
       VALUES ($1, nullif(current_setting('app.current_org',true),'')::uuid, $2, true)
       RETURNING id, name, is_active`,
      [positionId, name]
    );
    return NextResponse.json(rows[0]);
  });
}

/** PATCH — toggle is_active (dual-office exclusion). */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db) => {
    const { id, is_active } = body;
    if (!isUuid(id) || typeof is_active !== "boolean") {
      return NextResponse.json({ error: "id and is_active required" }, { status: 400 });
    }
    const { rows } = await db.query(
      "UPDATE candidates SET is_active=$1 WHERE id=$2 RETURNING id, name, is_active",
      [is_active, id]
    );
    if (!rows[0]) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    return NextResponse.json(rows[0]);
  });
}

/** DELETE — remove a candidate and any votes cast for them. */
export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  return withAdminElection(req, body, async (db) => {
    const { id } = body;
    if (!isUuid(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
    await db.query("DELETE FROM votes WHERE candidate_id=$1", [id]);
    const { rowCount } = await db.query("DELETE FROM candidates WHERE id=$1", [id]);
    if (!rowCount) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
