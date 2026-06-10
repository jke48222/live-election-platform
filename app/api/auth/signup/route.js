import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { hashPassword, createSession, sessionCookieHeader } from "../../../../lib/auth";
import { clientIpFromReq, rateLimit } from "../../../../lib/rate-limit";
import crypto from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /api/auth/signup { email, password, name } — create account + log in. */
export async function POST(req) {
  const ip = clientIpFromReq(req);
  const limited = rateLimit(`signup:${ip}`, 5, 60_000);
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
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  const existing = await query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (existing.rows.length) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  const verifyToken = crypto.randomBytes(24).toString("hex");
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, email_verification_token)
     VALUES ($1, $2, $3, $4) RETURNING id, email, name, email_verified`,
    [email, hashPassword(password), name || null, verifyToken]
  );
  const user = rows[0];

  // Email delivery is pluggable (SMTP) and wired in a later phase. Until then,
  // surface the verification link in dev so the flow is testable.
  const verifyUrl = `/api/auth/verify?token=${verifyToken}`;

  const { token, expires } = await createSession(user.id);
  const res = NextResponse.json({
    user,
    verify_url: process.env.NODE_ENV === "production" ? undefined : verifyUrl,
  });
  res.headers.set("Set-Cookie", sessionCookieHeader(token, expires));
  return res;
}
