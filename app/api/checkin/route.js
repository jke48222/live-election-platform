import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  canonicalDuesKey,
  isCheckinEligibleToVote,
  isDuesPayingMember,
} from "../../../lib/dues-roster";
import { isAdminRequest } from "../../../lib/admin-session";
import { clientIpFromReq, rateLimit } from "../../../lib/rate-limit";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

const MAX_NAME = 255;

/** POST — Register voter identity after PIN (same PIN as room). */
export async function POST(req) {
  // F14: throttle check-in attempts per IP — protects PIN and roster lookup
  const ip = clientIpFromReq(req);
  const limited = rateLimit(`checkin:${ip}`, 20, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many check-in attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { display_name, device_hash, pin } = body;

  if (!pin || pin !== process.env.NEXT_PUBLIC_ROOM_PIN) {
    return NextResponse.json({ error: "Invalid room PIN" }, { status: 401 });
  }

  const name = typeof display_name === "string" ? display_name.trim() : "";
  if (!name || name.length > MAX_NAME) {
    return NextResponse.json(
      { error: "Name is required (max 255 characters)." },
      { status: 400 }
    );
  }

  if (typeof device_hash !== "string" || !/^[0-9a-f]{64}$/.test(device_hash)) {
    return NextResponse.json({ error: "Invalid device identifier" }, { status: 400 });
  }

  const nameKey = canonicalDuesKey(name);
  if (!nameKey) {
    return NextResponse.json(
      { error: "Please enter your first and last name as on the roster." },
      { status: 400 }
    );
  }

  const supabase = getAdmin();

  const { data: existingRows, error: existingErr } = await supabase
    .from("voter_checkins")
    .select("device_hash, display_name, dues_verified_manual");

  if (existingErr) {
    return NextResponse.json({ error: existingErr.message }, { status: 500 });
  }

  const takenByOther = (existingRows || []).some(
    (row) => canonicalDuesKey(row.display_name) === nameKey && row.device_hash !== device_hash
  );
  if (takenByOther) {
    return NextResponse.json(
      {
        error:
          "This name is already checked in on another device. Use that device, or ask an admin to remove the other check-in.",
      },
      { status: 409 }
    );
  }

  const existingForDevice = (existingRows || []).find((row) => row.device_hash === device_hash);
  const priorKey = existingForDevice
    ? canonicalDuesKey(existingForDevice.display_name)
    : null;
  /* Admin "Confirm dues" sets dues_verified_manual. If the voter changes their checked-in name
     on the same device, we must clear it — otherwise non-roster names still show dues_ok. */
  const nameIdentityChanged = priorKey !== null && priorKey !== nameKey;

  const now = new Date().toISOString();

  const upsertRow = {
    device_hash,
    display_name: name,
    updated_at: now,
  };
  if (nameIdentityChanged) {
    upsertRow.dues_verified_manual = false;
  }

  const { error } = await supabase.from("voter_checkins").upsert(upsertRow, {
    onConflict: "device_hash",
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rosterMatch = isDuesPayingMember(name);
  const manualCarriesOver =
    !nameIdentityChanged && Boolean(existingForDevice?.dues_verified_manual);
  const duesOk = isCheckinEligibleToVote(name, manualCarriesOver);

  return NextResponse.json({
    ok: true,
    roster_auto_match: rosterMatch,
    dues_ok: duesOk,
  });
}

/** GET — Admin: list check-ins (name + timestamps only; not vote choices). */
export async function GET(req) {
  if (!isAdminRequest(req, null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getAdmin();
  const { data, error } = await supabase
    .from("voter_checkins")
    .select("display_name, created_at, updated_at, device_hash, dues_verified_manual")
    .order("display_name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = data || [];
  const nameKeyCounts = new Map();
  for (const row of rows) {
    const k = canonicalDuesKey(row.display_name);
    if (!k) continue;
    nameKeyCounts.set(k, (nameKeyCounts.get(k) || 0) + 1);
  }

  const checkins = rows.map((row) => {
    const rosterAutoMatch = isDuesPayingMember(row.display_name);
    const k = canonicalDuesKey(row.display_name);
    return {
      ...row,
      roster_auto_match: rosterAutoMatch,
      dues_ok: isCheckinEligibleToVote(row.display_name, row.dues_verified_manual),
      name_duplicate: Boolean(k && (nameKeyCounts.get(k) || 0) > 1),
    };
  });

  return NextResponse.json({ checkins });
}

/** PATCH — Admin: confirm dues-paid despite roster mismatch (clears flag in UI). */
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

  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "device_hash required" }, { status: 400 });
  }

  if (!body?.verify_dues) {
    return NextResponse.json({ error: "verify_dues required" }, { status: 400 });
  }

  const supabase = getAdmin();
  const now = new Date().toISOString();
  const { data: updatedRows, error } = await supabase
    .from("voter_checkins")
    .update({ dues_verified_manual: true, updated_at: now })
    .eq("device_hash", deviceHash)
    .select("device_hash");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!updatedRows?.length) {
    return NextResponse.json({ error: "No check-in found for this device" }, { status: 404 });
  }

  await supabase.channel("election_room").send({
    type: "broadcast",
    event: "dues_verified",
    payload: { device_hash: deviceHash },
  });

  return NextResponse.json({ ok: true });
}

/** DELETE — Admin: remove a check-in row (e.g. no dues or policy violation). */
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

  const deviceHash = typeof body?.device_hash === "string" ? body.device_hash.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
    return NextResponse.json({ error: "device_hash required" }, { status: 400 });
  }

  const supabase = getAdmin();
  const { data: deletedRows, error } = await supabase
    .from("voter_checkins")
    .delete()
    .eq("device_hash", deviceHash)
    .select("device_hash");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (deletedRows?.length) {
    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "checkin_revoked",
      payload: { device_hash: deviceHash },
    });
  }

  return NextResponse.json({ ok: true });
}
