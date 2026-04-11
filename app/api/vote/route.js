import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isCheckinEligibleToVote } from "../../../lib/dues-roster";
import { isAdminRequest } from "../../../lib/admin-session";
import { rateLimit } from "../../../lib/rate-limit";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

/** POST — Voter: cast vote (server enforces check-in, dues, poll window, candidate). */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const roleId = typeof body?.role_id === "string" ? body.role_id.trim() : "";
  const candidateId = typeof body?.candidate_id === "string" ? body.candidate_id.trim() : "";
  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";

  // F8: require exact 64-char lowercase hex SHA-256 hash
  if (!roleId || !candidateId || !/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json(
      { error: "role_id, candidate_id, and a valid device_hash are required." },
      { status: 400 }
    );
  }
  // candidate_id must be a UUID
  if (!/^[0-9a-f-]{36}$/i.test(candidateId)) {
    return NextResponse.json({ error: "Invalid candidate_id." }, { status: 400 });
  }

  // F14: throttle per device — 20 vote attempts / 10s
  const limited = rateLimit(`vote:${deviceHash}`, 20, 10_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many requests. Slow down." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  const supabase = getAdmin();

  const { data: checkin, error: checkinErr } = await supabase
    .from("voter_checkins")
    .select("display_name, dues_verified_manual")
    .eq("device_hash", deviceHash)
    .maybeSingle();

  if (checkinErr) {
    return NextResponse.json({ error: checkinErr.message }, { status: 500 });
  }
  if (!checkin) {
    return NextResponse.json(
      { error: "Not checked in. Rejoin the room from the login screen.", code: "not_checked_in" },
      { status: 403 }
    );
  }

  if (!isCheckinEligibleToVote(checkin.display_name, checkin.dues_verified_manual)) {
    return NextResponse.json(
      {
        error:
          "Your name is not on the automated dues list yet. Wait until an admin confirms your dues in the host dashboard.",
        code: "dues_required",
      },
      { status: 403 }
    );
  }

  const { data: state, error: stateErr } = await supabase.from("election_state").select("*").single();
  if (stateErr || !state) {
    return NextResponse.json(
      { error: stateErr?.message || "Election state unavailable." },
      { status: 500 }
    );
  }

  if (state.status !== "voting") {
    return NextResponse.json({ error: "Voting is not open for this poll." }, { status: 403 });
  }
  if (state.active_role_id !== roleId) {
    return NextResponse.json({ error: "This race is not the active poll." }, { status: 403 });
  }
  if (
    state.poll_expires_at &&
    new Date(state.poll_expires_at).getTime() <= Date.now()
  ) {
    return NextResponse.json({ error: "Voting time has expired." }, { status: 403 });
  }

  const { data: cand, error: candErr } = await supabase
    .from("candidates")
    .select("id")
    .eq("id", candidateId)
    .eq("role_id", roleId)
    .eq("is_active", true)
    .maybeSingle();

  if (candErr || !cand) {
    return NextResponse.json({ error: "Invalid candidate for this race." }, { status: 400 });
  }

  const { error: insErr } = await supabase.from("votes").insert({
    role_id: roleId,
    candidate_id: candidateId,
    device_hash: deviceHash,
  });

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/* GET /api/vote?role_id=xxx — Admin: fetch vote counts per candidate */
export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const roleId = searchParams.get("role_id");
  if (!roleId) return NextResponse.json({ error: "role_id required" }, { status: 400 });

  const supabase = getAdmin();

  const { data: votes, error } = await supabase
    .from("votes")
    .select("candidate_id")
    .eq("role_id", roleId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Aggregate counts
  const counts = {};
  for (const v of votes || []) {
    counts[v.candidate_id] = (counts[v.candidate_id] || 0) + 1;
  }

  return NextResponse.json({
    counts,
    total: votes?.length || 0,
  });
}
