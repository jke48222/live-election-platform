import { NextResponse } from "next/server";
import {
  adminCookieHeader,
  clearAdminCookieHeader,
  isAdminRequest,
  signAdminSession,
} from "../../../lib/admin-session";
import { clientIpFromReq, rateLimit } from "../../../lib/rate-limit";
import { withOrg } from "../../../lib/db";
import { emit } from "../../../lib/realtime";
import { resolveElectionOrg, isUuid, clampDuration } from "../../../lib/api-helpers";

/**
 * Election state machine — self-hosted Postgres + realtime NOTIFY.
 * Every mutating action is scoped to one election (body.election_id) and
 * runs inside withOrg() so RLS confines it to that election's organization.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action } = body || {};

  // ── Auth: mint a signed session cookie ──
  if (action === "auth") {
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
    const res = NextResponse.json({ ok: true });
    res.headers.set("Set-Cookie", adminCookieHeader(signAdminSession()));
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

  // All remaining actions are election-scoped.
  const electionId = typeof body.election_id === "string" ? body.election_id.trim() : "";
  if (!isUuid(electionId)) {
    return NextResponse.json({ error: "election_id required" }, { status: 400 });
  }
  const orgId = await resolveElectionOrg(electionId);
  if (!orgId) {
    return NextResponse.json({ error: "Unknown election_id" }, { status: 404 });
  }

  try {
    return await withOrg(orgId, async (db) => {
      const { rows: eRows } = await db.query(
        "SELECT id, status, active_position_id FROM elections WHERE id = $1 FOR UPDATE",
        [electionId]
      );
      const election = eRows[0];
      if (!election) {
        return NextResponse.json({ error: "Election not found" }, { status: 404 });
      }

      // ── LAUNCH a position's poll ──
      if (action === "launch") {
        const positionId =
          typeof body.position_id === "string" ? body.position_id.trim() : "";
        if (!isUuid(positionId)) {
          return NextResponse.json({ error: "position_id required" }, { status: 400 });
        }
        // F2: previous poll must be finalized first.
        if (election.status !== "waiting") {
          return NextResponse.json(
            { error: "Finalize or clear the current poll before launching another." },
            { status: 409 }
          );
        }
        // F1: position must belong to this election and not be completed.
        const { rows: pRows } = await db.query(
          "SELECT id, is_completed FROM positions WHERE id = $1 AND election_id = $2",
          [positionId, electionId]
        );
        if (!pRows[0]) {
          return NextResponse.json({ error: "Unknown position_id" }, { status: 404 });
        }
        if (pRows[0].is_completed) {
          return NextResponse.json(
            { error: "This position is already finalized. Reset it first to re-run." },
            { status: 409 }
          );
        }
        const duration = clampDuration(body.duration); // F9
        const expiresAt = new Date(Date.now() + duration * 1000).toISOString();
        await db.query(
          `UPDATE elections SET status='voting', active_position_id=$1,
             poll_expires_at=$2, updated_at=now() WHERE id=$3`,
          [positionId, expiresAt, electionId]
        );
        await emit(db, electionId, "state_change", {
          status: "voting",
          active_position_id: positionId,
          poll_expires_at: expiresAt,
        });
        return NextResponse.json({ ok: true });
      }

      // ── LOCK the live poll early ──
      if (action === "lock") {
        const now = new Date().toISOString();
        await db.query(
          "UPDATE elections SET status='locked', poll_expires_at=$1, updated_at=now() WHERE id=$2",
          [now, electionId]
        );
        await emit(db, electionId, "state_change", {
          status: "locked",
          active_position_id: election.active_position_id,
          poll_expires_at: now,
        });
        return NextResponse.json({ ok: true });
      }

      // ── FINALIZE the active position & advance ──
      if (action === "finalize") {
        if (election.active_position_id) {
          await db.query("UPDATE positions SET is_completed=true WHERE id=$1", [
            election.active_position_id,
          ]);
        }
        // If every position is now complete, the election itself is complete.
        const { rows: remaining } = await db.query(
          "SELECT count(*)::int AS n FROM positions WHERE election_id=$1 AND is_completed=false",
          [electionId]
        );
        const nextStatus = remaining[0].n === 0 ? "completed" : "waiting";
        await db.query(
          `UPDATE elections SET status=$1, active_position_id=NULL,
             poll_expires_at=NULL, updated_at=now() WHERE id=$2`,
          [nextStatus, electionId]
        );
        await emit(db, electionId, "state_change", {
          status: nextStatus,
          active_position_id: null,
          poll_expires_at: null,
        });
        return NextResponse.json({ ok: true });
      }

      // ── CLEAR votes & relaunch (tie-breaker / runoff) ──
      if (action === "clear_restart") {
        if (!election.active_position_id) {
          return NextResponse.json({ error: "No active position" }, { status: 400 });
        }
        const duration = clampDuration(body.duration);
        await db.query("DELETE FROM votes WHERE position_id=$1", [
          election.active_position_id,
        ]);
        const expiresAt = new Date(Date.now() + duration * 1000).toISOString();
        await db.query(
          "UPDATE elections SET status='voting', poll_expires_at=$1, updated_at=now() WHERE id=$2",
          [expiresAt, electionId]
        );
        await emit(db, electionId, "purge", {
          position_id: election.active_position_id,
        });
        await emit(db, electionId, "state_change", {
          status: "voting",
          active_position_id: election.active_position_id,
          poll_expires_at: expiresAt,
        });
        return NextResponse.json({ ok: true });
      }

      // ── RESET one position (votes + un-finalize), room idle only ──
      if (action === "reset_position") {
        const positionId =
          typeof body.position_id === "string" ? body.position_id.trim() : "";
        if (!isUuid(positionId)) {
          return NextResponse.json({ error: "position_id required" }, { status: 400 });
        }
        if (election.status !== "waiting" || election.active_position_id) {
          return NextResponse.json(
            { error: "Reset a position only when the room is waiting (no live or locked poll)." },
            { status: 409 }
          );
        }
        await db.query("DELETE FROM votes WHERE position_id=$1 AND election_id=$2", [
          positionId,
          electionId,
        ]);
        await db.query(
          "UPDATE positions SET is_completed=false WHERE id=$1 AND election_id=$2",
          [positionId, electionId]
        );
        await emit(db, electionId, "purge", { position_id: positionId });
        return NextResponse.json({ ok: true });
      }

      // ── RESET the whole election (F17: not mid-poll) ──
      if (action === "reset_all_results") {
        if (election.status !== "waiting" || election.active_position_id) {
          return NextResponse.json(
            { error: "Finish the current poll before resetting the entire election." },
            { status: 409 }
          );
        }
        await db.query("DELETE FROM votes WHERE election_id=$1", [electionId]);
        await db.query("UPDATE positions SET is_completed=false WHERE election_id=$1", [
          electionId,
        ]);
        await db.query(
          `UPDATE elections SET status='waiting', active_position_id=NULL,
             poll_expires_at=NULL, updated_at=now() WHERE id=$1`,
          [electionId]
        );
        await emit(db, electionId, "purge", { all: true });
        await emit(db, electionId, "state_change", {
          status: "waiting",
          active_position_id: null,
          poll_expires_at: null,
        });
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
