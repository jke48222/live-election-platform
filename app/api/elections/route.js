import { NextResponse } from "next/server";
import { query, withOrg } from "../../../lib/db";
import { getSessionUser, getMembershipRole, authorizeElection } from "../../../lib/auth";
import { isUuid } from "../../../lib/api-helpers";
import { isValidPin, PIN_RULE } from "../../../lib/eligibility";
import { emit } from "../../../lib/realtime";
import { checkinGuard } from "../../../lib/checkin-guard";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;
const ELIGIBILITY = ["open", "pin", "roster_csv", "email_magic_link", "access_code", "sso_oidc"];
const MODES = ["live_presenter", "scheduled_window"];

/** Resolve an org the caller can administer, by id or slug. Returns org row or null. */
async function adminOrg(user, { org_id, org_slug }) {
  let org;
  if (org_id) {
    org = (await query("SELECT id, slug FROM organizations WHERE id = $1", [org_id])).rows[0];
  } else if (org_slug) {
    org = (await query("SELECT id, slug FROM organizations WHERE slug = $1", [org_slug])).rows[0];
  }
  if (!org) return null;
  const role = await getMembershipRole(user.id, org.id);
  if (!role || !["owner", "admin", "staff"].includes(role)) return null;
  return org;
}

/**
 * GET /api/elections?org=<slug>          list elections for an org the caller admins.
 * GET /api/elections?election_id=<uuid>  one election's admin settings, including
 *                                        the room PIN (never in the public read).
 */
export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const electionId = params.get("election_id");
  if (electionId) {
    if (!isUuid(electionId)) {
      return NextResponse.json({ error: "Invalid election_id" }, { status: 400 });
    }
    const auth = await authorizeElection(req, electionId);
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const election = await withOrg(auth.orgId, async (db) => {
        const { rows } = await db.query(
          `SELECT id, slug, title, status, mode, eligibility_mode, pin
             FROM elections WHERE id = $1`,
          [electionId]
        );
        return rows[0] || null;
      });
      if (!election) return NextResponse.json({ error: "Election not found" }, { status: 404 });
      return NextResponse.json({ election });
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
  }

  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const orgSlug = params.get("org") || "";
  const org = await adminOrg(user, { org_slug: orgSlug });
  if (!org) return NextResponse.json({ error: "Not authorized for this org" }, { status: 403 });

  const elections = await withOrg(org.id, async (db) => {
    const { rows } = await db.query(
      `SELECT id, slug, title, status, mode, eligibility_mode, created_at
         FROM elections ORDER BY created_at DESC`
    );
    return rows;
  });
  return NextResponse.json({ org: { slug: org.slug }, elections });
}

/** POST /api/elections: create an election under an org the caller admins. */
export async function POST(req) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const org = await adminOrg(user, { org_id: body?.org_id, org_slug: body?.org_slug });
  if (!org) return NextResponse.json({ error: "Not authorized for this org" }, { status: 403 });

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const mode = MODES.includes(body?.mode) ? body.mode : "live_presenter";
  const eligibility_mode = ELIGIBILITY.includes(body?.eligibility_mode) ? body.eligibility_mode : "pin";
  const pin = typeof body?.pin === "string" ? body.pin.trim() : null;

  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Slug must be 3–50 chars: lowercase letters, numbers, hyphens." },
      { status: 400 }
    );
  }
  if (eligibility_mode === "pin" && !pin) {
    return NextResponse.json({ error: "A PIN is required for PIN eligibility." }, { status: 400 });
  }
  // 6 to 8 digits (lib/eligibility.js). Voters can type 4 to 8.
  if (pin && !isValidPin(pin)) {
    return NextResponse.json({ error: PIN_RULE }, { status: 400 });
  }

  try {
    const election = await withOrg(org.id, async (db) => {
      const dupe = await db.query("SELECT 1 FROM elections WHERE slug = $1", [slug]);
      if (dupe.rows.length) return { error: "An election with that slug already exists." };
      const { rows } = await db.query(
        `INSERT INTO elections (org_id, slug, title, mode, status, eligibility_mode, pin)
         VALUES (nullif(current_setting('app.current_org',true),'')::uuid, $1, $2, $3, 'waiting', $4, $5)
         RETURNING id, slug, title, status, mode, eligibility_mode`,
        [slug, title, mode, eligibility_mode, pin || null]
      );
      return { election: rows[0] };
    });
    if (election.error) return NextResponse.json({ error: election.error }, { status: 409 });
    return NextResponse.json({ org: { slug: org.slug }, election: election.election });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * PATCH /api/elections { election_id, title?, eligibility_mode?, pin? }: settings.
 *
 * Settings change only while no poll is live or locked, with one exception:
 * a request that sets only `pin` on a PIN election is allowed at any time, so
 * a host can rotate the PIN mid-meeting when the console shows someone
 * guessing it. Voters already checked in stay checked in.
 *
 * The result must be usable: PIN mode needs a 6 to 8 digit PIN. Changing
 * eligibility_mode removes every check-in and releases every roster, email
 * and code claim, because a check-in verified under the old mode (a PIN, say)
 * says nothing about the new one. Connected voters get checkin_revoked
 * { all: true } and settings_changed, and check in again under the new mode.
 */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isUuid(body?.election_id)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const auth = await authorizeElection(req, body.election_id);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await withOrg(auth.orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT status, active_position_id, eligibility_mode, pin FROM elections WHERE id = $1 FOR UPDATE",
        [body.election_id]
      );
      const current = eRows[0];
      if (!current) return { error: "Election not found", status: 404 };
      const pinOnly =
        typeof body.pin === "string" &&
        body.title === undefined &&
        body.eligibility_mode === undefined &&
        current.eligibility_mode === "pin";
      if ((current.status === "voting" || current.active_position_id) && !pinOnly) {
        return { error: "Finish the current poll before changing settings.", status: 409 };
      }
      const nextMode = ELIGIBILITY.includes(body.eligibility_mode)
        ? body.eligibility_mode
        : current.eligibility_mode;
      const nextPin = typeof body.pin === "string" ? body.pin.trim() || null : current.pin;
      if (typeof body.pin === "string" && nextPin && !isValidPin(nextPin)) {
        return { error: PIN_RULE, status: 400 };
      }
      const modeChanged = nextMode !== current.eligibility_mode;
      // A PIN election keeps working with a PIN set under the old 4-digit
      // rule until the host changes it; a new or changed PIN must meet the rule.
      if (nextMode === "pin" && (modeChanged || typeof body.pin === "string") && !isValidPin(nextPin || "")) {
        return { error: "Set a 6 to 8 digit room PIN before switching to PIN mode.", status: 400 };
      }
      const fields = [];
      const params = [];
      if (typeof body.title === "string" && body.title.trim()) {
        params.push(body.title.trim());
        fields.push(`title = $${params.length}`);
      }
      if (ELIGIBILITY.includes(body.eligibility_mode)) {
        params.push(nextMode);
        fields.push(`eligibility_mode = $${params.length}`);
      }
      if (typeof body.pin === "string") {
        params.push(nextPin);
        fields.push(`pin = $${params.length}`);
      }
      if (fields.length === 0) return { error: "Nothing to update", status: 400 };
      params.push(body.election_id);
      const { rows } = await db.query(
        `UPDATE elections SET ${fields.join(", ")}, updated_at = now()
          WHERE id = $${params.length}
          RETURNING id, slug, title, status, mode, eligibility_mode, pin`,
        params
      );
      // A new PIN makes earlier guesses worthless, so the slowdown ends.
      if (typeof body.pin === "string" && nextPin !== current.pin) checkinGuard.reset(body.election_id.toLowerCase());
      if (!modeChanged) return { election: rows[0] };

      const { rowCount: cleared } = await db.query(
        "DELETE FROM checkins WHERE election_id = $1",
        [body.election_id]
      );
      await db.query(
        "UPDATE eligible_voters SET claimed_by_device = NULL WHERE election_id = $1",
        [body.election_id]
      );
      await emit(db, body.election_id, "checkin_revoked", { all: true });
      await emit(db, body.election_id, "settings_changed", { eligibility_mode: nextMode });
      return { election: rows[0], checkins_cleared: cleared };
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
