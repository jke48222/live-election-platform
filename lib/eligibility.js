/**
 * Pluggable voter-eligibility providers. Generalizes the old NSBE dues roster
 * into a small set of strategies selected per election by eligibility_mode:
 *
 *   open              — anyone with the link (no check-in required to vote)
 *   pin               — room PIN (validated in the check-in route)
 *   roster_csv        — name/ID must be on an uploaded roster → auto-verified
 *   email_magic_link  — email must be on an allowlist → auto-verified
 *   access_code       — a single-use code, bound to the first device that uses it
 *   sso_oidc          — placeholder: requires manual verification for now
 *
 * resolveEligibility() is called inside the check-in transaction (it may claim
 * an access code), so it receives the live db client.
 */

/** Normalize an identifier (name/email/code) for stable matching. */
export function normalizeIdentifier(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Decide whether a check-in attempt is eligible / verified.
 * Returns { ok, verified, error?, code? }. ok=false means reject the check-in.
 */
export async function resolveEligibility(db, election, { displayName, email, code, deviceHash }) {
  const mode = election.eligibility_mode;

  if (mode === "open" || mode === "pin") {
    return { ok: true, verified: true };
  }

  if (mode === "roster_csv") {
    // On the roster → auto-verified; otherwise allowed in but pending a manual
    // verify by the host (mirrors the original dues-roster behavior).
    const key = normalizeIdentifier(displayName);
    const { rows } = await db.query(
      "SELECT 1 FROM eligible_voters WHERE election_id = $1 AND identifier = $2",
      [election.id, key]
    );
    return { ok: true, verified: rows.length > 0 };
  }

  if (mode === "email_magic_link") {
    const key = normalizeIdentifier(email || displayName);
    if (!key.includes("@")) {
      return { ok: false, error: "A valid email is required.", code: "email_required" };
    }
    const { rows } = await db.query(
      "SELECT 1 FROM eligible_voters WHERE election_id = $1 AND identifier = $2",
      [election.id, key]
    );
    if (!rows.length) {
      return { ok: false, error: "This email isn't on the voter list.", code: "not_eligible" };
    }
    return { ok: true, verified: true };
  }

  if (mode === "access_code") {
    const c = normalizeIdentifier(code);
    if (!c) return { ok: false, error: "An access code is required.", code: "code_required" };
    const { rows } = await db.query(
      "SELECT id, claimed_by_device FROM eligible_voters WHERE election_id = $1 AND lower(token) = $2",
      [election.id, c]
    );
    if (!rows.length) {
      return { ok: false, error: "Invalid access code.", code: "invalid_code" };
    }
    const ev = rows[0];
    if (ev.claimed_by_device && ev.claimed_by_device !== deviceHash) {
      return { ok: false, error: "This access code has already been used.", code: "code_used" };
    }
    // Bind the code to this device on first use (idempotent for the same device).
    await db.query(
      "UPDATE eligible_voters SET used_at = COALESCE(used_at, now()), claimed_by_device = $1 WHERE id = $2",
      [deviceHash, ev.id]
    );
    return { ok: true, verified: true };
  }

  // sso_oidc / unknown: not auto-verified yet (host verifies manually).
  return { ok: true, verified: false };
}

/** Modes whose identity is the name (so a duplicate display name is a conflict). */
export function nameIsIdentity(mode) {
  return mode === "pin" || mode === "open" || mode === "roster_csv";
}
