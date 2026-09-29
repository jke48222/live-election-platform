import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { verifyLogin, createSession, sessionCookieHeader } from "../../../../lib/auth";
import {
  clientIpFromReq,
  deviceRateLimit,
  failureBlocked,
  rateLimit,
  recordFailure,
} from "../../../../lib/rate-limit";
import { realtimeSecret } from "../../../../lib/realtime";
import {
  FAILURE_WINDOW_MS,
  knownDeviceCookieHeader,
  knownDeviceNonce,
  knownDeviceValue,
  loginFailurePlan,
} from "../../../../lib/login-guard";

/** The key for known-device cookies, or null when none is configured. */
function cookieSecret() {
  try {
    return realtimeSecret();
  } catch {
    return null;
  }
}

function tooMany(retryAfter) {
  return NextResponse.json(
    { error: "Too many attempts. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/** POST /api/auth/login { email, password } */
export async function POST(req) {
  const ip = clientIpFromReq(req);
  if (ip) {
    const limited = rateLimit(`login:${ip}`, 10, 60_000);
    if (!limited.ok) return tooMany(limited.retryAfter);
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
  if (email.length > 320 || password.length > 1024) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  // Wrong passwords are counted per source, so a stranger cannot lock the
  // host out (lib/login-guard.js). The same rules apply to unknown emails,
  // so the answer reveals nothing about which accounts exist.
  const secret = cookieSecret();
  const plan = loginFailurePlan({ email, ip, knownNonce: knownDeviceNonce(req, email, secret) });
  for (const { key, limit } of plan.checks) {
    const blocked = failureBlocked(key, limit, FAILURE_WINDOW_MS);
    if (!blocked.ok) return tooMany(blocked.retryAfter);
  }
  const burst = deviceRateLimit(plan.burst, 20, 60_000);
  if (!burst.ok) return tooMany(burst.retryAfter);

  const { rows } = await query(
    "SELECT id, email, name, email_verified, password_hash FROM users WHERE email = $1",
    [email]
  );
  const user = rows[0];
  // Unknown emails are checked against a dummy hash, so both paths take as long.
  const ok = await verifyLogin(password, user?.password_hash || null);
  if (!ok || !user) {
    for (const key of plan.records) recordFailure(key, FAILURE_WINDOW_MS);
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const { token, expires } = await createSession(user.id);
  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, email_verified: user.email_verified },
  });
  res.headers.append("Set-Cookie", sessionCookieHeader(token, expires));
  // Marks this browser as one the account has signed in from, so other
  // people's wrong passwords never lock it out.
  if (secret) {
    res.headers.append(
      "Set-Cookie",
      knownDeviceCookieHeader(knownDeviceValue(email, secret), {
        secure: process.env.NODE_ENV === "production",
      })
    );
  }
  return res;
}
