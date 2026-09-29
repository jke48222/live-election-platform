-- ============================================================
--  0007_vote_tallies: keep counts, not one row per vote
--
--  After 0005, cast_ballot() wrote a ballots_cast row (who voted)
--  and a votes row (what they chose) in one transaction. Both rows
--  carried that transaction's id in xmin and sat in the same heap
--  order, so a join on xmin, or on row order, matched every named
--  voter to their choice. pg_dump writes rows in heap order, so a
--  backup gave the same answer.
--
--  Now the choice is kept as one counter per candidate:
--    vote_tallies (position_id, candidate_id, n)
--  and cast_ballot() adds the vote by updating every counter of
--  the race in one statement, n + 1 for the chosen candidate and
--  n + 0 for the others. Every live counter of a race therefore
--  carries the xmin of the latest ballot in that race, whatever was
--  chosen, and no row is added per vote.
--
--  What this covers: the admin UI and API, SQL queries by any role
--  (the owner included), and logical backups from pg_dump. What it
--  does not cover: Postgres keeps the old version of a counter until
--  vacuum removes it, and writes every change to the WAL. Someone
--  who can read raw data pages (a superuser with pageinspect), the
--  WAL, or a physical backup can still put the changes in order and
--  match them to ballots_cast. Run VACUUM vote_tallies after each
--  race, and treat WAL archives and physical backups as secret.
--
--  votes stays as a read-only view with one row per vote, so
--  `SELECT candidate_id, count(*) FROM votes ... GROUP BY` keeps
--  working. DELETE FROM votes still clears votes (runoff, reset,
--  removing a candidate): it lowers the counters, and a race left
--  with no votes has its ballots_cast rows cleared, so its voters
--  can vote again. Votes can only be added through cast_ballot().
-- ============================================================

CREATE TABLE vote_tallies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  n            integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  CONSTRAINT one_tally_per_candidate UNIQUE (position_id, candidate_id)
);

CREATE INDEX idx_vote_tallies_election  ON vote_tallies(election_id);
CREATE INDEX idx_vote_tallies_candidate ON vote_tallies(candidate_id);

-- Carry the existing votes over as counts.
INSERT INTO vote_tallies (election_id, org_id, position_id, candidate_id, n)
  SELECT election_id, org_id, position_id, candidate_id, count(*)::int
    FROM votes
   GROUP BY election_id, org_id, position_id, candidate_id;

-- The old table, its clearing trigger and that trigger's function.
DROP TABLE votes;
DROP FUNCTION clear_ballots_after_vote_delete();

GRANT SELECT, INSERT, UPDATE, DELETE ON vote_tallies TO app;

ALTER TABLE vote_tallies ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON vote_tallies
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);

-- ── votes: one row per vote, read from the counters ──
-- security_invoker makes the caller's RLS apply to vote_tallies,
-- so the view shows only the current org's votes.
CREATE VIEW votes WITH (security_invoker = true) AS
  SELECT t.election_id, t.org_id, t.position_id, t.candidate_id
    FROM vote_tallies t
   CROSS JOIN LATERAL generate_series(1, t.n) AS g(i);

REVOKE ALL ON votes FROM app;
GRANT SELECT, DELETE ON votes TO app;

/*
  A race left with no votes has its ballots_cast rows cleared, so its
  voters can vote again. Called after counters go down or go away.
*/
CREATE FUNCTION clear_ballots_of_empty_races(p_positions uuid[])
  RETURNS void
  LANGUAGE sql
  SECURITY INVOKER
  SET search_path = public
AS $$
  DELETE FROM ballots_cast b
   WHERE b.position_id = ANY (p_positions)
     AND NOT EXISTS (SELECT 1 FROM vote_tallies t
                      WHERE t.position_id = b.position_id AND t.n > 0);
$$;

REVOKE ALL ON FUNCTION clear_ballots_of_empty_races(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_ballots_of_empty_races(uuid[]) TO app;

-- DELETE FROM votes: each deleted view row takes one vote off its counter.
CREATE FUNCTION votes_view_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
AS $$
BEGIN
  UPDATE vote_tallies
     SET n = n - 1
   WHERE position_id = OLD.position_id
     AND candidate_id = OLD.candidate_id
     AND n > 0;
  PERFORM clear_ballots_of_empty_races(ARRAY[OLD.position_id]);
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION votes_view_delete() FROM PUBLIC;

CREATE TRIGGER votes_delete
  INSTEAD OF DELETE ON votes
  FOR EACH ROW
  EXECUTE FUNCTION votes_view_delete();

-- Counters removed by a cascade (a candidate deleted outright) also
-- reopen a race they leave empty, as deleting votes rows did before.
CREATE FUNCTION vote_tallies_after_delete()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public
AS $$
BEGIN
  PERFORM clear_ballots_of_empty_races(ARRAY(SELECT DISTINCT position_id FROM removed_tallies));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION vote_tallies_after_delete() FROM PUBLIC;

CREATE TRIGGER vote_tallies_clear_ballots
  AFTER DELETE ON vote_tallies
  REFERENCING OLD TABLE AS removed_tallies
  FOR EACH STATEMENT
  EXECUTE FUNCTION vote_tallies_after_delete();

/*
  cast_ballot: the only way the app records a vote. Same signature
  and result as in 0005: true when the vote was recorded, false when
  this voter already voted in this race. It runs as the caller
  (SECURITY INVOKER), so RLS and the caller's app.current_org apply.
*/
CREATE OR REPLACE FUNCTION cast_ballot(
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
  -- A choice outside the race would record a ballot and count nothing.
  IF NOT EXISTS (SELECT 1 FROM candidates c
                  JOIN positions p ON p.id = c.position_id
                 WHERE c.id = p_candidate
                   AND c.position_id = p_position
                   AND p.election_id = p_election) THEN
    RAISE EXCEPTION 'cast_ballot: candidate is not in this race' USING ERRCODE = '23503';
  END IF;

  INSERT INTO ballots_cast (election_id, org_id, position_id, voter_ref)
    VALUES (p_election, v_org, p_position, p_voter_ref)
    ON CONFLICT ON CONSTRAINT one_ballot_per_voter_per_position DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- One counter for every candidate in the race, so the update below
  -- touches the same rows whatever was chosen.
  INSERT INTO vote_tallies (election_id, org_id, position_id, candidate_id)
    SELECT p_election, v_org, c.position_id, c.id
      FROM candidates c
     WHERE c.position_id = p_position
    ON CONFLICT ON CONSTRAINT one_tally_per_candidate DO NOTHING;

  -- Lock the race's counters in a fixed order, so two voters in the
  -- same race wait for each other instead of deadlocking.
  PERFORM 1 FROM vote_tallies
    WHERE position_id = p_position
    ORDER BY candidate_id
    FOR UPDATE;

  UPDATE vote_tallies
     SET n = n + (candidate_id = p_candidate)::int
   WHERE position_id = p_position;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION cast_ballot(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cast_ballot(uuid, uuid, uuid, text) TO app;
