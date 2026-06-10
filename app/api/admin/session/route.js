import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../../lib/admin-session";

/**
 * GET /api/admin/session — lightweight auth probe for the admin UI.
 * Returns 200 if the request carries a valid admin session, else 401.
 * (Used on dashboard mount and to detect session expiry, independent of
 * any election context.)
 */
export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
