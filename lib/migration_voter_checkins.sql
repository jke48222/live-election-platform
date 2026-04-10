-- Run once in Supabase SQL Editor (existing projects).
-- New installs: this is also merged into lib/schema.sql.

CREATE TABLE IF NOT EXISTS public.voter_checkins (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_hash             VARCHAR(64) NOT NULL UNIQUE,
  display_name            VARCHAR(255) NOT NULL,
  dues_verified_manual    BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voter_checkins_display_name
  ON public.voter_checkins (lower(display_name));

ALTER TABLE public.voter_checkins ENABLE ROW LEVEL SECURITY;

-- No anon policies: check-ins only via service role (Next.js API).

COMMENT ON TABLE public.voter_checkins IS
  'Voter identity at room join (dues/attendance). Not linked to ballot choices.';
