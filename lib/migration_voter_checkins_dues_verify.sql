-- Run once in Supabase SQL Editor (adds manual dues verification for flagged check-ins).

ALTER TABLE public.voter_checkins
  ADD COLUMN IF NOT EXISTS dues_verified_manual BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.voter_checkins.dues_verified_manual IS
  'Host confirmed member is dues-paid despite name not matching roster.';
