import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdminRequest } from "../../../lib/admin-session";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

/** Plurality among active candidates; same shape for one role or list. */
async function winnerRowForRole(supabase, role) {
  const { data: cands } = await supabase
    .from("candidates")
    .select("id, name, is_active")
    .eq("role_id", role.id);

  const { data: votes } = await supabase
    .from("votes")
    .select("candidate_id")
    .eq("role_id", role.id);

  const counts = {};
  for (const v of votes || []) {
    counts[v.candidate_id] = (counts[v.candidate_id] || 0) + 1;
  }

  const active = (cands || []).filter((c) => c.is_active);
  let max = 0;
  for (const c of active) {
    max = Math.max(max, counts[c.id] || 0);
  }

  const base = {
    role_id: role.id,
    title: role.title,
    sort_order: role.sort_order,
    is_completed: !!role.is_completed,
  };

  if (active.length === 0) {
    return {
      ...base,
      names: [],
      display: "—",
      is_tie: false,
      vote_count: 0,
      total_votes: votes?.length || 0,
    };
  }

  if (max === 0) {
    return {
      ...base,
      names: [],
      display: "No votes",
      is_tie: false,
      vote_count: 0,
      total_votes: votes?.length || 0,
    };
  }

  const leaders = active.filter((c) => (counts[c.id] || 0) === max);
  return {
    ...base,
    names: leaders.map((c) => c.name),
    display: leaders.map((c) => c.name).join(" · "),
    is_tie: leaders.length > 1,
    vote_count: max,
    total_votes: votes?.length || 0,
  };
}

/** GET — Admin: ?role_id= → one role; else all completed roles. */
export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getAdmin();
  const { searchParams } = new URL(req.url);
  const singleId = searchParams.get("role_id");

  if (singleId) {
    const { data: role, error } = await supabase
      .from("roles")
      .select("id, title, sort_order, is_completed")
      .eq("id", singleId)
      .single();
    if (error || !role) {
      return NextResponse.json({ error: "Role not found" }, { status: 404 });
    }
    const winner = await winnerRowForRole(supabase, role);
    return NextResponse.json({ winner });
  }

  const { data: roles, error: rErr } = await supabase
    .from("roles")
    .select("id, title, sort_order, is_completed")
    .order("sort_order");

  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  const completed = (roles || []).filter((r) => r.is_completed);
  const rows = [];
  for (const role of completed) {
    rows.push(await winnerRowForRole(supabase, role));
  }
  rows.sort((a, b) => a.sort_order - b.sort_order);

  return NextResponse.json({ winners: rows });
}
