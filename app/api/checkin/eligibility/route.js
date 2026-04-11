import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isCheckinEligibleToVote } from "../../../../lib/dues-roster";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

/**
 * POST — Voter: refresh dues eligibility (device_hash acts as secret; no PIN).
 * Used after realtime reconnect / tab focus so "Confirm dues" applies without a full rejoin.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }

  const supabase = getAdmin();
  const { data: row, error } = await supabase
    .from("voter_checkins")
    .select("display_name, dues_verified_manual")
    .eq("device_hash", deviceHash)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json({ checked_in: false, dues_ok: false });
  }

  return NextResponse.json({
    checked_in: true,
    dues_ok: isCheckinEligibleToVote(row.display_name, row.dues_verified_manual),
  });
}
