import { NextResponse } from "next/server";
import { withOrg } from "../../../lib/db";
import { authorizeElection } from "../../../lib/auth";
import { resolveElectionOrg, isUuid } from "../../../lib/api-helpers";
import { nameKey } from "../../_lib/poll";
import { isIdle } from "../../../lib/state-guards";

const DUPLICATE_NAME = "This position already has a candidate with that name.";

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

  const admin = !!(await authorizeElection(req, electionId));
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

/** Admin: authorize via org membership, then run inside the org's RLS scope. */
async function withAdminElection(req, body, fn) {
  const electionId = typeof body?.election_id === "string" ? body.election_id.trim() : "";
  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const auth = await authorizeElection(req, electionId);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await withOrg(auth.orgId, (db) => fn(db, electionId));
  } catch (err) {
    if (err.code === "23505") return NextResponse.json({ error: DUPLICATE_NAME }, { status: 409 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Candidates change only while the room is idle (no live or locked poll) and
 * their race is not finalized. Otherwise a live ballot could change under
 * voters, and deleting a candidate (and so their votes) could rewrite a
 * result already announced. Locks the election row, like /api/state, so the
 * check and the edit cannot be split by a launch. Returns { position } or
 * { refusal } (a response to send).
 */
async function lockForBallotEdit(db, electionId, { positionId = null, candidateId = null }) {
  const { rows: eRows } = await db.query(
    "SELECT status, active_position_id FROM elections WHERE id=$1 FOR UPDATE",
    [electionId]
  );
  if (!eRows[0]) {
    return { refusal: NextResponse.json({ error: "Election not found" }, { status: 404 }) };
  }
  if (!isIdle(eRows[0])) {
    return {
      refusal: NextResponse.json(
        { error: "Finish the current poll before changing candidates." },
        { status: 409 }
      ),
    };
  }
  const { rows } = candidateId
    ? await db.query(
        `SELECT p.id, p.is_completed FROM candidates c JOIN positions p ON p.id = c.position_id
          WHERE c.id = $1 AND p.election_id = $2`,
        [candidateId, electionId]
      )
    : await db.query("SELECT id, is_completed FROM positions WHERE id=$1 AND election_id=$2", [
        positionId,
        electionId,
      ]);
  if (!rows[0]) {
    const error = candidateId ? "Candidate not found" : "Unknown position";
    return { refusal: NextResponse.json({ error }, { status: 404 }) };
  }
  if (rows[0].is_completed) {
    return {
      refusal: NextResponse.json(
        { error: "This race is finalized. Reset it before changing its candidates." },
        { status: 409 }
      ),
    };
  }
  return { position: rows[0] };
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
    // Position must belong to this election, the room must be idle and the
    // race not finalized.
    const { refusal } = await lockForBallotEdit(db, electionId, { positionId });
    if (refusal) return refusal;

    // A repeated submit (double Enter) or a second host adding the same
    // nominee would split the vote between two identical ballot entries.
    const { rows: existing } = await db.query(
      "SELECT name FROM candidates WHERE position_id=$1",
      [positionId]
    );
    const key = nameKey(name);
    if (existing.some((c) => nameKey(c.name) === key)) {
      return NextResponse.json({ error: DUPLICATE_NAME }, { status: 409 });
    }

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
  return withAdminElection(req, body, async (db, electionId) => {
    const { id, is_active } = body;
    if (!isUuid(id) || typeof is_active !== "boolean") {
      return NextResponse.json({ error: "id and is_active required" }, { status: 400 });
    }
    const { refusal } = await lockForBallotEdit(db, electionId, { candidateId: id });
    if (refusal) return refusal;
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
  return withAdminElection(req, body, async (db, electionId) => {
    const { id } = body;
    if (!isUuid(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { refusal } = await lockForBallotEdit(db, electionId, { candidateId: id });
    if (refusal) return refusal;
    await db.query("DELETE FROM votes WHERE candidate_id=$1", [id]);
    const { rowCount } = await db.query("DELETE FROM candidates WHERE id=$1", [id]);
    if (!rowCount) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
