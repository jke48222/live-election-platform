import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

/* GET /api/vote?role_id=xxx — Admin: fetch vote counts per candidate */
export async function GET(req) {
  const pw = req.headers.get("x-admin-password");
  if (pw !== process.env.ADMIN_PASSWORD) {
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
