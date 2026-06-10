-- ============================================================
--  0003_auth — self-hosted user sessions + email verification
--
--  users / memberships / organizations already exist (0001) as
--  control-plane tables (no RLS; app-layer guarded). This adds
--  DB-backed sessions (revocable) and an email-verification token.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token text;

CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,        -- sha256(raw cookie token)
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_sessions TO app;
