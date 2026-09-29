-- ============================================================
--  0006_unique_ballot_names: one candidate name per race, one
--  race title per election
--
--  The candidates and positions routes already refuse a duplicate
--  (ignoring case and runs of spaces, see nameKey() in
--  app/_lib/poll.js), but two requests at the same moment could
--  both pass that check. These indexes make the database refuse
--  the second insert; the routes turn the 23505 into a 409.
--
--  The key is lower-cased, with each run of whitespace turned into
--  one space and the ends trimmed, which matches nameKey().
--
--  Existing duplicates are renamed first ("Ada Lovelace (2)"), not
--  deleted, so no candidate and no vote is lost.
-- ============================================================

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY position_id, lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
           ORDER BY sort_order, id
         ) AS n
    FROM candidates
)
UPDATE candidates c
   SET name = c.name || ' (' || ranked.n || ')'
  FROM ranked
 WHERE c.id = ranked.id AND ranked.n > 1;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY election_id, lower(btrim(regexp_replace(title, '\s+', ' ', 'g')))
           ORDER BY sort_order, id
         ) AS n
    FROM positions
)
UPDATE positions p
   SET title = p.title || ' (' || ranked.n || ')'
  FROM ranked
 WHERE p.id = ranked.id AND ranked.n > 1;

CREATE UNIQUE INDEX IF NOT EXISTS candidates_position_name_uniq
  ON candidates (position_id, lower(btrim(regexp_replace(name, '\s+', ' ', 'g'))));

CREATE UNIQUE INDEX IF NOT EXISTS positions_election_title_uniq
  ON positions (election_id, lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))));
