-- ============================================================
--  0005_ballot_secrecy: split who voted from what they chose
--
--  Before this migration, votes kept voter_identity (the device
--  id) next to candidate_id, and checkins kept the same device id
--  next to display_name. One join showed every named voter's
--  choice.
--
--  This migration adds ballots_cast (position_id, voter_ref), which
--  records who took part and is UNIQUE per position, so one vote
--  per voter. votes loses its identity and time columns. Neither
--  table has a timestamp.
--
--  That alone does not hide a choice from someone with database
--  access: cast_ballot() writes both rows in one transaction, so
--  they share xmin and sit in the same heap order. 0007 replaces
--  the per-vote rows with per-candidate counters to close that.
--
--  Voter identities are also moved to the format the app now uses,
--  voterKey() in lib/voter-identity.js:
--    sha256('<election id>:<device id>') as lowercase hex
--  in checkins.device_hash, eligible_voters.claimed_by_device and
--  ballots_cast.voter_ref. Before this, all three held the raw
--  device id, which is the voter's secret. A ballot cast from a
--  device that holds a roster, email or code entry is carried over
--  under that entry's ref, as ballotRef() records it:
--    'ev:' || sha256('<election id>:<identifier>') as lowercase hex
--  (entryRef() in lib/voter-identity.js). So a database migrated in
--  the middle of an election keeps one vote per voter per race, and
--  voters keep their check-ins.
--
--  Clearing votes (runoff, reset) goes through DELETE FROM votes as
--  before; a trigger then clears ballots_cast for every position
--  left with no votes, so those voters can vote again.
--
--  Also puts audit_log under the same org_isolation policy as the
--  other tenant tables.
-- ============================================================

-- The keys voterKey() and entryRef() compute, for rewriting stored
-- raw device ids. Both are dropped at the end of this migration.
CREATE FUNCTION pg_temp.voter_key(p_election uuid, p_device text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(lower(p_election::text) || ':' || p_device, 'UTF8')), 'hex')
$$;

CREATE FUNCTION pg_temp.entry_ref(p_election uuid, p_identifier text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT 'ev:' || encode(sha256(convert_to(lower(p_election::text) || ':' || p_identifier, 'UTF8')), 'hex')
$$;

CREATE TABLE ballots_cast (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  voter_ref   text NOT NULL,       -- device_hash / email / member id / sso subject
  CONSTRAINT one_ballot_per_voter_per_position UNIQUE (position_id, voter_ref)
);

CREATE INDEX idx_ballots_cast_election ON ballots_cast(election_id);

-- Carry existing participation over under the refs /api/vote now
-- records: the entry's ref for a device that holds an eligible_voters
-- entry in a roster, email or code election (the same entry
-- ballotRef() picks), otherwise the device's key. This reads the raw ids, so it
-- runs before they are rewritten below.
WITH claims AS (
  SELECT DISTINCT ON (ev.election_id, ev.claimed_by_device)
         ev.election_id, ev.claimed_by_device, ev.identifier
    FROM eligible_voters ev
    JOIN elections e ON e.id = ev.election_id
   WHERE ev.claimed_by_device IS NOT NULL
     AND e.eligibility_mode IN ('roster_csv', 'email_magic_link', 'access_code')
   ORDER BY ev.election_id, ev.claimed_by_device, ev.used_at NULLS LAST, ev.id
)
INSERT INTO ballots_cast (election_id, org_id, position_id, voter_ref)
  SELECT v.election_id, v.org_id, v.position_id,
         coalesce(pg_temp.entry_ref(c.election_id, c.identifier),
                  pg_temp.voter_key(v.election_id, v.voter_identity))
    FROM votes v
    LEFT JOIN claims c
      ON c.election_id = v.election_id AND c.claimed_by_device = v.voter_identity
  ON CONFLICT DO NOTHING;

-- Stop storing the raw device id anywhere.
UPDATE checkins
   SET device_hash = pg_temp.voter_key(election_id, device_hash);
UPDATE eligible_voters
   SET claimed_by_device = pg_temp.voter_key(election_id, claimed_by_device)
 WHERE claimed_by_device IS NOT NULL;

-- Strip identity and time from votes.

ALTER TABLE votes DROP CONSTRAINT one_vote_per_voter_per_position;
ALTER TABLE votes DROP COLUMN voter_identity;
ALTER TABLE votes DROP COLUMN created_at;

GRANT SELECT, INSERT, UPDATE, DELETE ON ballots_cast TO app;

ALTER TABLE ballots_cast ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ballots_cast
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

-- ── audit_log: tenant rows, same isolation as the rest ──
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_log
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

/*
  cast_ballot: the only way the app should record a vote.
  It runs as the caller (SECURITY INVOKER), so RLS and the caller's
  app.current_org apply. It returns true when the vote was recorded
  and false when this voter already voted for this position.
*/
CREATE FUNCTION cast_ballot(
  p_election  uuid,
  p_position  uuid,
  p_candidate uuid,
  p_voter_ref text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
AS $$
DECLARE
  v_org uuid := nullif(current_setting('app.current_org', true), '')::uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'cast_ballot needs app.current_org' USING ERRCODE = '42501';
  END IF;
  IF p_voter_ref IS NULL OR p_voter_ref = '' THEN
    RAISE EXCEPTION 'cast_ballot needs a voter reference' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ballots_cast (election_id, org_id, position_id, voter_ref)
    VALUES (p_election, v_org, p_position, p_voter_ref)
    ON CONFLICT ON CONSTRAINT one_ballot_per_voter_per_position DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO votes (election_id, org_id, position_id, candidate_id)
    VALUES (p_election, v_org, p_position, p_candidate);
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION cast_ballot(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cast_ballot(uuid, uuid, uuid, text) TO app;

-- ── Clearing votes reopens the position for its voters ──
CREATE FUNCTION clear_ballots_after_vote_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
AS $$
BEGIN
  DELETE FROM ballots_cast b
   WHERE b.position_id IN (SELECT DISTINCT position_id FROM removed_votes)
     AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.position_id = b.position_id);
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION clear_ballots_after_vote_delete() FROM PUBLIC;

CREATE TRIGGER votes_clear_ballots
  AFTER DELETE ON votes
  REFERENCING OLD TABLE AS removed_votes
  FOR EACH STATEMENT
  EXECUTE FUNCTION clear_ballots_after_vote_delete();

DROP FUNCTION pg_temp.voter_key(uuid, text);
DROP FUNCTION pg_temp.entry_ref(uuid, text);
