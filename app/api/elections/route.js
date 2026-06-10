import { NextResponse } from "next/server";
import { query, withOrg } from "../../../lib/db";
import { getSessionUser, getMembershipRole } from "../../../lib/auth";

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

/** GET /api/elections?org=<slug> — list elections for an org the caller admins. */
export async function GET(req) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const orgSlug = new URL(req.url).searchParams.get("org") || "";
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

/** POST /api/elections — create an election under an org the caller admins. */
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

  try {
    const election = await withOrg(org.id, async (db) => {
      const dupe = await db.query("SELECT 1 FROM elections WHERE slug = $1", [slug]);
      if (dupe.rows.length) return { error: "An election with that slug already exists." };
      const { rows } = await db.query(
        `INSERT INTO elections (org_id, slug, title, mode, status, eligibility_mode, pin)
         VALUES (nullif(current_setting('app.current_org',true),'')::uuid, $1, $2, $3, 'waiting', $4, $5)
         RETURNING id, slug, title, status, mode, eligibility_mode`,
        [slug, title, mode, eligibility_mode, pin]
      );
      return { election: rows[0] };
    });
    if (election.error) return NextResponse.json({ error: election.error }, { status: 409 });
    return NextResponse.json({ org: { slug: org.slug }, election: election.election });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
