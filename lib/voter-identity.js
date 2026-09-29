/**
 * Voter identity on the server. Server code only (uses node:crypto).
 *
 * The voter page sends a random device id (lib/fingerprint.js) as
 * `device_hash`. That id is the voter's secret. The server never stores it;
 * it stores voterKey(electionId, deviceId), a one-way hash, in
 * checkins.device_hash, eligible_voters.claimed_by_device and
 * ballots_cast.voter_ref. So the host's check-in list, the database and its
 * backups hold nothing that /api/vote or /api/checkin would accept.
 *
 * The same key is the `device_tag` in check-in realtime events. The voter
 * page computes it itself (SHA-256 of "<election id>:<device id>") to spot
 * events about its own device; the check-in response also returns it.
 *
 * In the roster, email and access-code modes a check-in claims one
 * eligible_voters row, and the ballot is recorded under entryRef(): a hash of
 * the election and the entry's normalized name, email or code, rather than
 * the device or the row id. Moving the entry to another device (the host
 * removes a check-in) or deleting and re-adding it (the host fixes a typo in
 * the roster) keeps the same ref, so the one-ballot-per-race rule in
 * ballots_cast still holds for that person. The row id used to be the ref,
 * and a re-added row got a new id and a second ballot.
 */
import crypto from "node:crypto";

const DEVICE_ID_RE = /^[0-9a-f]{64}$/;

/** True for a well-formed device id (64 lowercase hex characters). */
export function isDeviceId(v) {
  return typeof v === "string" && DEVICE_ID_RE.test(v);
}

/** The stored key for one device in one election (64 hex characters). */
export function voterKey(electionId, deviceId) {
  if (!electionId || !isDeviceId(deviceId)) throw new Error("voterKey needs an election id and a device id");
  return crypto
    .createHash("sha256")
    .update(`${String(electionId).toLowerCase()}:${deviceId}`)
    .digest("hex");
}

/** Eligibility modes where each check-in claims one eligible_voters row. */
export const CLAIM_MODES = new Set(["roster_csv", "email_magic_link", "access_code"]);

/**
 * The voter_ref for an eligible_voters entry: "ev:" and the SHA-256 of
 * "<election id>:<identifier>". eligible_voters.identifier is already
 * normalized (lower case, single spaces; access codes lower case), and it is
 * unique per election, so one entry maps to one ref however often it is
 * re-added.
 */
export function entryRef(electionId, identifier) {
  if (!electionId || typeof identifier !== "string" || !identifier) {
    throw new Error("entryRef needs an election id and an identifier");
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${String(electionId).toLowerCase()}:${identifier}`)
    .digest("hex");
  return `ev:${digest}`;
}

/**
 * The voter_ref to record a ballot under: the claimed eligible_voters entry
 * in a claim mode (entryRef), otherwise the device's key.
 */
export async function ballotRef(db, electionId, mode, key) {
  if (CLAIM_MODES.has(mode)) {
    const { rows } = await db.query(
      `SELECT identifier FROM eligible_voters
        WHERE election_id = $1 AND claimed_by_device = $2
        ORDER BY used_at NULLS LAST, id LIMIT 1`,
      [electionId, key]
    );
    if (rows[0]) return entryRef(electionId, rows[0].identifier);
  }
  return key;
}
