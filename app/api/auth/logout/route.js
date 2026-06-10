import { NextResponse } from "next/server";
import { destroySession, getSessionCookie, clearSessionCookieHeader } from "../../../../lib/auth";

/** POST /api/auth/logout */
export async function POST(req) {
  await destroySession(getSessionCookie(req));
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookieHeader());
  return res;
}
