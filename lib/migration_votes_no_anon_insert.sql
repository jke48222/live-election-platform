-- Revoke direct anon inserts on votes. All ballots must go through POST /api/vote (service role).
-- Run in Supabase SQL Editor after deploying the app change that submits votes via the API.

DROP POLICY IF EXISTS "anon can insert votes" ON public.votes;
