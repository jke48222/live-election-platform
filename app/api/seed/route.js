import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ELECTION_SLATE } from "../../../lib/seed-data.mjs";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export async function POST(req) {
  const body = await req.json();
  if (body.password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getAdmin();

  // Clear existing data
  await supabase.from("voter_checkins").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("votes").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("candidates").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("roles").delete().neq("id", "____");

  // Reset election state
  const { data: stateRow } = await supabase.from("election_state").select("id").single();
  if (stateRow) {
    await supabase
      .from("election_state")
      .update({
        status: "waiting",
        active_role_id: null,
        poll_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", stateRow.id);
  } else {
    await supabase.from("election_state").insert({
      status: "waiting",
      active_role_id: null,
      poll_expires_at: null,
    });
  }

  // Insert roles
  const roleRows = ELECTION_SLATE.map((r) => ({
    id: r.id,
    title: r.title,
    sort_order: r.sort_order,
    is_completed: false,
  }));
  const { error: roleErr } = await supabase.from("roles").insert(roleRows);
  if (roleErr) return NextResponse.json({ error: roleErr.message }, { status: 500 });

  // Insert candidates
  const candidateRows = [];
  for (const role of ELECTION_SLATE) {
    for (const name of role.candidates) {
      candidateRows.push({
        role_id: role.id,
        name,
        is_active: true,
      });
    }
  }
  const { error: candErr } = await supabase.from("candidates").insert(candidateRows);
  if (candErr) return NextResponse.json({ error: candErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    roles: roleRows.length,
    candidates: candidateRows.length,
  });
}
