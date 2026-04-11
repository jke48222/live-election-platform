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

/* POST — Add floor nomination / write-in candidate */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const roleId = typeof body?.role_id === "string" ? body.role_id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!roleId || !name) {
    return NextResponse.json({ error: "role_id and name required" }, { status: 400 });
  }
  if (name.length > 255) {
    return NextResponse.json({ error: "Name too long (max 255)" }, { status: 400 });
  }

  const supabase = getAdmin();
  const { data, error } = await supabase
    .from("candidates")
    .insert({ role_id: roleId, name, is_active: true })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/* PATCH — Toggle is_active (dual-office exclusion) */
export async function PATCH(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, is_active } = body;
  if (!id || typeof is_active !== "boolean") {
    return NextResponse.json({ error: "id and is_active required" }, { status: 400 });
  }

  const supabase = getAdmin();
  const { data, error } = await supabase
    .from("candidates")
    .update({ is_active })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/* DELETE — Remove candidate from ballot (and any votes cast for them) */
export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = body;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = getAdmin();

  await supabase.from("votes").delete().eq("candidate_id", id);

  const { error } = await supabase.from("candidates").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
