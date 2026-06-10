import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";

/**
 * GET /api/auth/verify?token=...  — confirm an email address.
 * (Email delivery is pluggable/SMTP and added later; the token is issued at
 * signup and, in dev, returned in the signup response.)
 */
export async function GET(req) {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

  const { rowCount } = await query(
    "UPDATE users SET email_verified = true, email_verification_token = NULL WHERE email_verification_token = $1",
    [token]
  );
  if (!rowCount) {
    return NextResponse.json({ error: "Invalid or already-used token" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, verified: true });
}
