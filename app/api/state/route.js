import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  adminCookieHeader,
  clearAdminCookieHeader,
  isAdminRequest,
  signAdminSession,
} from "../../../lib/admin-session";
import { clientIpFromReq, rateLimit } from "../../../lib/rate-limit";

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action } = body || {};

  // Auth check: mint a signed session cookie on success
  if (action === "auth") {
    // Brute-force throttle: 10 attempts / 60s / IP
    const ip = clientIpFromReq(req);
    const limited = rateLimit(`admin-auth:${ip}`, 10, 60 * 1000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfter) } }
      );
    }
    if (body.password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    const token = signAdminSession();
    const res = NextResponse.json({ ok: true });
    res.headers.set("Set-Cookie", adminCookieHeader(token));
    return res;
  }

  if (action === "logout") {
    const res = NextResponse.json({ ok: true });
    res.headers.set("Set-Cookie", clearAdminCookieHeader());
    return res;
  }

  if (!isAdminRequest(req, body)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getAdmin();

  /* ── LAUNCH POLL (PRD §4.2, §4.3) ── */
  if (action === "launch") {
    const rawRoleId = typeof body.role_id === "string" ? body.role_id.trim() : "";
    if (!rawRoleId) {
      return NextResponse.json({ error: "role_id required" }, { status: 400 });
    }
    // F9: clamp duration to sane range
    const rawDuration = Number(body.duration);
    const duration = Number.isFinite(rawDuration)
      ? Math.min(600, Math.max(5, Math.floor(rawDuration)))
      : 60;

    const {
      data: stateRow,
      error: fetchErr,
    } = await supabase.from("election_state").select("id, status").single();

    if (fetchErr || !stateRow) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row — run DB seed/migration" },
        { status: 500 }
      );
    }

    // F2: require previous poll finalized before launching another
    if (stateRow.status !== "waiting") {
      return NextResponse.json(
        { error: "Finalize or clear the current poll before launching another." },
        { status: 409 }
      );
    }

    // F1: verify the role exists and isn't already finalized
    const { data: roleRow, error: roleErr } = await supabase
      .from("roles")
      .select("id, is_completed")
      .eq("id", rawRoleId)
      .maybeSingle();
    if (roleErr) {
      return NextResponse.json({ error: roleErr.message }, { status: 500 });
    }
    if (!roleRow) {
      return NextResponse.json({ error: "Unknown role_id" }, { status: 404 });
    }
    if (roleRow.is_completed) {
      return NextResponse.json(
        { error: "This role is already finalized. Reset it first if you want to re-run." },
        { status: 409 }
      );
    }

    // Calculate absolute expiration timestamp
    const expiresAt = new Date(Date.now() + duration * 1000).toISOString();

    const { error } = await supabase
      .from("election_state")
      .update({
        status: "voting",
        active_role_id: rawRoleId,
        poll_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", stateRow.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Broadcast to all clients (PRD §4.2 — Broadcast API)
    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "state_change",
      payload: {
        status: "voting",
        active_role_id: rawRoleId,
        poll_expires_at: expiresAt,
      },
    });

    return NextResponse.json({ ok: true });
  }

  /* ── LOCK POLL EARLY (PRD §7.2) ── */
  if (action === "lock") {
    const { data: state, error: fetchErr } = await supabase
      .from("election_state")
      .select("*")
      .single();

    if (fetchErr || !state) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row — run DB seed/migration" },
        { status: 500 }
      );
    }

    const { error } = await supabase
      .from("election_state")
      .update({
        status: "locked",
        poll_expires_at: new Date().toISOString(), // override to now()
        updated_at: new Date().toISOString(),
      })
      .eq("id", state.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "state_change",
      payload: {
        status: "locked",
        active_role_id: state.active_role_id,
        poll_expires_at: new Date().toISOString(),
      },
    });

    return NextResponse.json({ ok: true });
  }

  /* ── FINALIZE ROLE & ADVANCE ── */
  if (action === "finalize") {
    const { data: state, error: fetchErr } = await supabase
      .from("election_state")
      .select("*")
      .single();

    if (fetchErr || !state) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row — run DB seed/migration" },
        { status: 500 }
      );
    }

    // Mark role as completed
    if (state.active_role_id) {
      await supabase
        .from("roles")
        .update({ is_completed: true })
        .eq("id", state.active_role_id);
    }

    // Reset state to waiting
    await supabase
      .from("election_state")
      .update({
        status: "waiting",
        active_role_id: null,
        poll_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", state.id);

    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "state_change",
      payload: { status: "waiting", active_role_id: null, poll_expires_at: null },
    });

    return NextResponse.json({ ok: true });
  }

  /* ── CLEAR VOTES & RESTART (tie-breaker — PRD §2.3) ── */
  if (action === "clear_restart") {
    const rawDuration = Number(body.duration);
    const duration = Number.isFinite(rawDuration)
      ? Math.min(600, Math.max(5, Math.floor(rawDuration)))
      : 60;
    const { data: state, error: fetchErr } = await supabase
      .from("election_state")
      .select("*")
      .single();

    if (fetchErr || !state) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row — run DB seed/migration" },
        { status: 500 }
      );
    }

    if (!state.active_role_id) {
      return NextResponse.json({ error: "No active role" }, { status: 400 });
    }

    // DELETE all votes for this role
    await supabase.from("votes").delete().eq("role_id", state.active_role_id);

    // Relaunch
    const expiresAt = new Date(Date.now() + duration * 1000).toISOString();
    await supabase
      .from("election_state")
      .update({
        status: "voting",
        poll_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", state.id);

    // Broadcast purge event to clear client LocalStorage (PRD §2.3)
    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "purge",
      payload: { type: "purge", role_id: state.active_role_id },
    });

    // Then broadcast new state
    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "state_change",
      payload: {
        status: "voting",
        active_role_id: state.active_role_id,
        poll_expires_at: expiresAt,
      },
    });

    return NextResponse.json({ ok: true });
  }

  /* ── RESET ONE ROLE (votes + un-finalize) — admin only, room idle ── */
  if (action === "reset_role") {
    const { role_id } = body;
    if (!role_id) {
      return NextResponse.json({ error: "role_id required" }, { status: 400 });
    }

    const { data: state, error: fetchErr } = await supabase
      .from("election_state")
      .select("*")
      .single();

    if (fetchErr || !state) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row" },
        { status: 500 }
      );
    }

    if (state.status !== "waiting" || state.active_role_id) {
      return NextResponse.json(
        { error: "Reset a poll only when the room is waiting (no live or locked poll)." },
        { status: 400 }
      );
    }

    await supabase.from("votes").delete().eq("role_id", role_id);
    await supabase.from("roles").update({ is_completed: false }).eq("id", role_id);

    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "purge",
      payload: { type: "purge", role_id },
    });

    return NextResponse.json({ ok: true });
  }

  /* ── RESET ALL RESULTS (all votes, all roles open, waiting) ── */
  if (action === "reset_all_results") {
    const { data: stateRow, error: fetchErr } = await supabase
      .from("election_state")
      .select("id, status, active_role_id")
      .single();

    if (fetchErr || !stateRow) {
      return NextResponse.json(
        { error: fetchErr?.message || "No election_state row" },
        { status: 500 }
      );
    }

    // F17: don't nuke votes mid-poll
    if (stateRow.status !== "waiting" || stateRow.active_role_id) {
      return NextResponse.json(
        { error: "Finish the current poll before resetting the entire election." },
        { status: 409 }
      );
    }

    await supabase
      .from("votes")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("roles").update({ is_completed: false }).neq("id", "____");

    await supabase
      .from("election_state")
      .update({
        status: "waiting",
        active_role_id: null,
        poll_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", stateRow.id);

    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "purge",
      payload: { type: "purge", all: true },
    });

    await supabase.channel("election_room").send({
      type: "broadcast",
      event: "state_change",
      payload: { status: "waiting", active_role_id: null, poll_expires_at: null },
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
