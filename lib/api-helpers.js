/**
 * Shared helpers for the election-scoped API routes (Phase 1+3).
 *
 * Auth note: routes still use the existing global admin session
 * (lib/admin-session.js). Phase 2 replaces this with per-org membership
 * checks — at which point resolveElectionOrg's result is cross-checked
 * against the caller's org. For now any authenticated admin may act on any
 * election (acceptable transitional state, documented in PLATFORM_PLAN.md).
 */
import { query } from "./db.js";

/** Resolve an election's org_id via the SECURITY DEFINER helper (0002). */
export async function resolveElectionOrg(electionId) {
  if (!isUuid(electionId)) return null;
  const { rows } = await query("SELECT election_org($1) AS org", [electionId]);
  return rows[0]?.org || null;
}

export function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Clamp a live-poll duration to a sane range (preserves F9). */
export function clampDuration(raw, fallback = 60) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(600, Math.max(5, Math.floor(n))) : fallback;
}
