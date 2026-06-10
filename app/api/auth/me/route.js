import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { getSessionUser } from "../../../../lib/auth";

/**
 * GET /api/auth/me — current user + the organizations they belong to (with
 * role). Returns { user: null } when not authenticated (200, not 401, so the
 * client can branch without treating it as an error).
 */
export async function GET(req) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ user: null });

  const { rows: orgs } = await query(
    `SELECT o.id, o.slug, o.name, o.type, m.role
       FROM memberships m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY o.name`,
    [user.id]
  );
  return NextResponse.json({ user, orgs });
}
