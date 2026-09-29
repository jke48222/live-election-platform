-- ============================================================
--  0008_voter_lookup_indexes: indexes for the per-voter lookups
--
--  Two queries run on every check-in and every vote, and both
--  filtered a whole election's rows before this migration:
--
--  * /api/checkin/eligibility reads which races a voter has
--    already voted in:
--      SELECT DISTINCT position_id FROM ballots_cast
--       WHERE election_id = $1 AND voter_ref = $2
--    The unique key on ballots_cast is (position_id, voter_ref),
--    which cannot serve a lookup by election.
--
--  * ballotRef() in lib/voter-identity.js and heldClaim() in
--    lib/eligibility.js find the roster entry a device holds:
--      SELECT ... FROM eligible_voters
--       WHERE election_id = $1 AND claimed_by_device = $2
--    Most entries are unclaimed, so the second index is partial.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_ballots_cast_voter
  ON ballots_cast (election_id, voter_ref);

CREATE INDEX IF NOT EXISTS idx_eligible_claimed
  ON eligible_voters (election_id, claimed_by_device)
  WHERE claimed_by_device IS NOT NULL;
