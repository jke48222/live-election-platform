/**
 * Voter eligibility, selected per election by eligibility_mode:
 *
 *   open              anyone with the link (no check-in required to vote)
 *   pin               room PIN (checked in the check-in route with pinMatches)
 *   roster_csv        name on the uploaded roster: verified, and the roster
 *                     entry is claimed by this device. Names not on the
 *                     roster check in pending until the host verifies them.
 *   email_magic_link  email on the allowlist: verified and claimed. No link
 *                     is emailed yet, so the email itself is the proof.
 *   access_code       single-use code, claimed by the first device to use it
 *   sso_oidc          placeholder: the host verifies manually for now
 *
 * A claim is one atomic UPDATE, so two devices racing for the same entry
 * cannot both win. A device that holds a claim cannot switch to another
 * entry; the host has to remove its check-in first, which releases the claim.
 *
 * resolveEligibility() runs inside the check-in transaction and receives its
 * db client. Server code only (uses node:crypto).
 */
import crypto from "node:crypto";

/** Normalize an identifier (name/email/code) for stable matching. */
export function normalizeIdentifier(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A host sets a room PIN of 6 to 8 digits. Check-in refuses nobody for other
 * people's wrong guesses (lib/checkin-guard.js), so the PIN's length is what
 * makes guessing slow: a million 6-digit PINs against 4-digit PINs' ten
 * thousand. The voter's PIN field takes 4 to 8 digits, so a room whose
 * 4-digit PIN was set before this rule still works until the host changes it.
 */
export const PIN_RE = /^\d{6,8}$/;
export const PIN_RULE = "The room PIN must be 6 to 8 digits.";

export function isValidPin(pin) {
  return typeof pin === "string" && PIN_RE.test(pin);
}

/**
 * Constant-time PIN check. Fails closed: false when the election has no PIN
 * or the caller sent anything but a string.
 */
export function pinMatches(expected, given) {
  if (typeof expected !== "string" || expected === "" || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Modes whose identity is the name (so a duplicate display name is a conflict). */
export function nameIsIdentity(mode) {
  return mode === "pin" || mode === "open" || mode === "roster_csv";
}

// Roster names and emails are rows without a token; access codes have one.
const MATCH = {
  roster_csv: "identifier = $2 AND token IS NULL",
  email_magic_link: "identifier = $2 AND token IS NULL",
  access_code: "token IS NOT NULL AND lower(token) = $2",
};

const KIND = {
  roster_csv: "name",
  email_magic_link: "email",
  access_code: "access code",
};

/** The eligible_voters row this device already holds in the election, if any. */
async function heldClaim(db, electionId, key) {
  const { rows } = await db.query(
    `SELECT id, identifier, token FROM eligible_voters
      WHERE election_id = $1 AND claimed_by_device = $2
      ORDER BY used_at NULLS LAST, id LIMIT 1`,
    [electionId, key]
  );
  return rows[0] || null;
}

function sameEntry(mode, row, value) {
  if (mode === "access_code") return !!row.token && row.token.toLowerCase() === value;
  return row.token === null && row.identifier === value;
}

/**
 * Claim the entry for `key` in one statement. Returns { id } on success,
 * { taken: true } when another device holds it, { missing: true } when
 * there is no such entry.
 */
async function claimEntry(db, electionId, mode, value, key) {
  const match = MATCH[mode];
  const { rows } = await db.query(
    `UPDATE eligible_voters
        SET claimed_by_device = $3, used_at = COALESCE(used_at, now())
      WHERE election_id = $1 AND ${match}
        AND (claimed_by_device IS NULL OR claimed_by_device = $3)
      RETURNING id`,
    [electionId, value, key]
  );
  if (rows[0]) return { id: rows[0].id };
  const { rows: exists } = await db.query(
    `SELECT 1 FROM eligible_voters WHERE election_id = $1 AND ${match} LIMIT 1`,
    [electionId, value]
  );
  return exists.length ? { taken: true } : { missing: true };
}

/**
 * Decide whether a check-in attempt is eligible and verified.
 *
 * `voterKey` is the device's stored key (lib/voter-identity.js), never the
 * raw device id. Returns { ok: true, verified, claimId? } or
 * { ok: false, status, error, code, failure? }. failure=true marks a wrong
 * secret (code or email), which the route counts toward its guessing limit.
 */
export async function resolveEligibility(db, election, { displayName, email, code, voterKey }) {
  const mode = election.eligibility_mode;

  if (mode === "open" || mode === "pin") {
    return { ok: true, verified: true };
  }
  if (!MATCH[mode]) {
    // sso_oidc / unknown: not auto-verified yet (host verifies manually).
    return { ok: true, verified: false };
  }

  let value;
  if (mode === "roster_csv") {
    value = normalizeIdentifier(displayName);
  } else if (mode === "email_magic_link") {
    value = normalizeIdentifier(email || displayName);
    if (!value.includes("@")) {
      return { ok: false, status: 403, error: "A valid email is required.", code: "email_required" };
    }
  } else {
    value = normalizeIdentifier(code);
    if (!value) {
      return { ok: false, status: 403, error: "An access code is required.", code: "code_required" };
    }
  }

  const held = await heldClaim(db, election.id, voterKey);
  if (held && !sameEntry(mode, held, value)) {
    return {
      ok: false,
      status: 409,
      code: "identity_locked",
      error: `This device is already checked in with a different ${KIND[mode]}. Ask the host to remove that check-in first.`,
    };
  }

  const result = await claimEntry(db, election.id, mode, value, voterKey);
  if (result.id) return { ok: true, verified: true, claimId: result.id };

  if (mode === "roster_csv") {
    if (result.taken) {
      return {
        ok: false,
        status: 409,
        code: "identity_in_use",
        error: "This name is already checked in on another device.",
      };
    }
    // Not on the roster: allowed in, pending a manual verify by the host.
    return { ok: true, verified: false };
  }

  if (mode === "email_magic_link") {
    if (result.taken) {
      return {
        ok: false,
        status: 409,
        code: "identity_in_use",
        error: "This email is already checked in on another device.",
      };
    }
    return {
      ok: false,
      status: 403,
      code: "not_eligible",
      error: "This email isn't on the voter list.",
      failure: true,
    };
  }

  // access_code
  if (result.taken) {
    return {
      ok: false,
      status: 403,
      code: "code_used",
      error: "This access code has already been used.",
      failure: true,
    };
  }
  return { ok: false, status: 403, code: "invalid_code", error: "Invalid access code.", failure: true };
}

/** Release every entry this device holds (the host removed its check-in). */
export async function releaseClaims(db, electionId, key) {
  await db.query(
    "UPDATE eligible_voters SET claimed_by_device = NULL WHERE election_id = $1 AND claimed_by_device = $2",
    [electionId, key]
  );
}
