-- ============================================================
--  0004_eligibility — bind access codes / magic links to a device
--
--  eligible_voters (0001) backs the roster_csv, email_magic_link, and
--  access_code providers. This adds claimed_by_device so a single-use
--  access code (or magic link) can be locked to the first device that
--  redeems it, while still letting that same device re-check-in.
-- ============================================================

ALTER TABLE eligible_voters ADD COLUMN IF NOT EXISTS claimed_by_device text;

CREATE INDEX IF NOT EXISTS idx_eligible_token ON eligible_voters (election_id, lower(token));
