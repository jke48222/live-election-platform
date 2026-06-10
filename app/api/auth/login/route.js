import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { verifyPassword, createSession, sessionCookieHeader } from "../../../../lib/auth";
import { clientIpFromReq, rateLimit } from "../../../../lib/rate-limit";

/** POST /api/auth/login { email, password } */
export async function POST(req) {
  const ip = clientIpFromReq(req);
  const limited = rateLimit(`login:${ip}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  const { rows } = await query(
    "SELECT id, email, name, email_verified, password_hash FROM users WHERE email = $1",
    [email]
  );
  const user = rows[0];
  // Constant-ish path: always verify against something to reduce user enumeration.
  const ok = user ? verifyPassword(password, user.password_hash) : false;
  if (!ok) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const { token, expires } = await createSession(user.id);
  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, email_verified: user.email_verified },
  });
  res.headers.set("Set-Cookie", sessionCookieHeader(token, expires));
  return res;
}
