/**
 * Shared helpers for the election-scoped API routes.
 *
 * Admin routes authorize via per-org RBAC (lib/auth.js authorizeElection),
 * which resolves the election's org and checks the session user's membership.
 * resolveElectionOrg below is used by the PUBLIC (unauthenticated) voter
 * reads, which scope to the election's org without a membership check.
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

/**
 * Clamp a live-poll duration to 10 to 300 seconds (preserves F9). The admin
 * console enforces the same range (POLL_TIMER_MIN_SEC and POLL_TIMER_MAX_SEC
 * in app/_lib/poll.js), so this only matters for direct API calls.
 */
export const DURATION_MIN_SEC = 10;
export const DURATION_MAX_SEC = 300;
export function clampDuration(raw, fallback = 60) {
  const n = Number(raw);
  return Number.isFinite(n)
    ? Math.min(DURATION_MAX_SEC, Math.max(DURATION_MIN_SEC, Math.floor(n)))
    : fallback;
}
