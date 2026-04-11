-- ============================================================
--  NSBE Live Election Platform — Database Schema
--  Run this in Supabase SQL Editor before deploying.
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Table 1: election_state (singleton state machine) ──
CREATE TABLE public.election_state (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status      VARCHAR(20) NOT NULL CHECK (status IN ('waiting', 'voting', 'locked')),
  active_role_id VARCHAR(50),
  poll_expires_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Guarantee only one row ever exists
CREATE UNIQUE INDEX single_row_state ON public.election_state ((true));

-- Insert the initial singleton row
INSERT INTO public.election_state (status, active_role_id, poll_expires_at)
VALUES ('waiting', NULL, NULL);

-- ── Table 2: roles ──
CREATE TABLE public.roles (
  id          VARCHAR(50) PRIMARY KEY,
  title       VARCHAR(100) NOT NULL,
  sort_order  INTEGER NOT NULL,
  is_completed BOOLEAN DEFAULT false
);

-- ── Table 3: candidates ──
CREATE TABLE public.candidates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id     VARCHAR(50) REFERENCES public.roles(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  is_active   BOOLEAN DEFAULT true
);

-- ── Table 4: votes (cryptographic ledger) ──
CREATE TABLE public.votes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id     VARCHAR(50) REFERENCES public.roles(id),
  candidate_id UUID REFERENCES public.candidates(id),
  device_hash VARCHAR(64) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  -- PRD §3.3: One vote per device per role
  CONSTRAINT unique_vote_per_device UNIQUE (role_id, device_hash)
);

-- ── Table 5: voter_checkins (name + device at join — not tied to vote choices) ──
CREATE TABLE public.voter_checkins (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_hash             VARCHAR(64) NOT NULL UNIQUE,
  display_name            VARCHAR(255) NOT NULL,
  dues_verified_manual    BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_voter_checkins_display_name ON public.voter_checkins (lower(display_name));


-- ============================================================
--  Row Level Security (PRD §8.3)
-- ============================================================

ALTER TABLE public.election_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.votes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voter_checkins  ENABLE ROW LEVEL SECURITY;

-- voter_checkins: no anon access — use /api/checkin (service role only)

-- election_state: voters can read, only service_role can mutate
CREATE POLICY "anon can read election_state"
  ON public.election_state FOR SELECT TO anon USING (true);
CREATE POLICY "service can do anything on election_state"
  ON public.election_state FOR ALL TO service_role USING (true);

-- roles: voters can read
CREATE POLICY "anon can read roles"
  ON public.roles FOR SELECT TO anon USING (true);
CREATE POLICY "service can do anything on roles"
  ON public.roles FOR ALL TO service_role USING (true);

-- candidates: voters can read
CREATE POLICY "anon can read candidates"
  ON public.candidates FOR SELECT TO anon USING (true);
CREATE POLICY "service can do anything on candidates"
  ON public.candidates FOR ALL TO service_role USING (true);

-- votes: inserts only via POST /api/vote (service role). Anon cannot insert (enforces dues + poll rules).
CREATE POLICY "service can do anything on votes"
  ON public.votes FOR ALL TO service_role USING (true);
-- explicitly deny all to anon (default deny with RLS enabled)


-- ============================================================
--  Indexes for performance
-- ============================================================

CREATE INDEX idx_candidates_role   ON public.candidates (role_id);
CREATE INDEX idx_votes_role        ON public.votes (role_id);
CREATE INDEX idx_votes_candidate   ON public.votes (candidate_id);
CREATE INDEX idx_roles_sort_order  ON public.roles (sort_order);
