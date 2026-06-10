import { NextResponse } from "next/server";
import { query } from "../../../lib/db";
import { getSessionUser } from "../../../lib/auth";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/** POST /api/orgs { name, slug, type } — create an org; caller becomes owner. */
export async function POST(req) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const type = ["individual", "club", "college"].includes(body?.type) ? body.type : "club";

  if (!name) return NextResponse.json({ error: "Organization name is required." }, { status: 400 });
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Slug must be 3–40 chars: lowercase letters, numbers, hyphens." },
      { status: 400 }
    );
  }

  const dupe = await query("SELECT 1 FROM organizations WHERE slug = $1", [slug]);
  if (dupe.rows.length) {
    return NextResponse.json({ error: "That slug is taken." }, { status: 409 });
  }

  const plan = await query("SELECT id FROM plans WHERE key = 'free_beta'");
  const planId = plan.rows[0]?.id || null;

  const { rows } = await query(
    `INSERT INTO organizations (slug, name, type, plan_id, subscription_status, branding)
     VALUES ($1, $2, $3, $4, 'beta', $5)
     RETURNING id, slug, name, type`,
    [slug, name, type, planId, JSON.stringify({ display_name: name })]
  );
  const org = rows[0];

  await query(
    "INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')",
    [org.id, user.id]
  );

  return NextResponse.json({ org: { ...org, role: "owner" } });
}
