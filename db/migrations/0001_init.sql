-- ============================================================
--  0001_init — Universal Election Platform: multi-tenant core
--
--  Replaces the single-tenant NSBE schema (lib/schema.sql).
--  Tenancy: organization -> election -> position -> candidate.
--  Isolation: Postgres RLS keyed on the per-request GUC
--             app.current_org (set by lib/db.js withOrg()).
--
--  The least-privilege login role `app` must exist before this
--  runs; db/migrate.mjs ensures it. The `app` role is NOT the
--  table owner, so RLS is enforced against it.
-- ============================================================

-- gen_random_uuid() is built into PostgreSQL 13+ core; no extension needed.

-- ── Control plane: plans (subscription tiers) ──
CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text UNIQUE NOT NULL,
  name        text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  interval    text NOT NULL DEFAULT 'month' CHECK (interval IN ('month','year','once','none')),
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Tenant root: organizations ──
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'club' CHECK (type IN ('individual','club','college')),
  branding    jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_id     uuid REFERENCES plans(id),
  subscription_status text NOT NULL DEFAULT 'beta',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Control plane: users (global identity, may join many orgs) ──
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE NOT NULL,
  password_hash  text,
  name           text,
  email_verified boolean NOT NULL DEFAULT false,
  totp_secret    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Control plane: memberships (user <-> org, RBAC) ──
CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- ── Control plane: subscriptions ──
CREATE TABLE subscriptions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id   uuid NOT NULL REFERENCES plans(id),
  status    text NOT NULL DEFAULT 'active',
  current_period_end timestamptz,
  provider     text,
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Tenant data: elections (replaces the election_state singleton) ──
CREATE TABLE elections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  title       text NOT NULL,
  description text,
  mode        text NOT NULL DEFAULT 'live_presenter'
                CHECK (mode IN ('live_presenter','scheduled_window')),
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','scheduled','waiting','voting','locked','completed')),
  active_position_id uuid,                 -- FK added after positions table exists
  poll_expires_at    timestamptz,          -- live mode countdown target (UTC)
  opens_at           timestamptz,          -- scheduled mode
  closes_at          timestamptz,          -- scheduled mode
  eligibility_mode   text NOT NULL DEFAULT 'pin'
                CHECK (eligibility_mode IN
                  ('open','pin','roster_csv','email_magic_link','access_code','sso_oidc')),
  pin         text,                         -- used when eligibility_mode = 'pin'
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- ── Tenant data: positions (generalizes NSBE "roles") ──
CREATE TABLE positions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title        text NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  max_winners  integer NOT NULL DEFAULT 1 CHECK (max_winners >= 1),
  is_completed boolean NOT NULL DEFAULT false
);

-- elections.active_position_id references a position (nullable, set on launch)
ALTER TABLE elections
  ADD CONSTRAINT elections_active_position_fk
  FOREIGN KEY (active_position_id) REFERENCES positions(id) ON DELETE SET NULL;

-- ── Tenant data: candidates ──
CREATE TABLE candidates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  bio         text,
  photo_url   text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0
);

-- ── Tenant data: eligible_voters (roster / email-link / access codes) ──
CREATE TABLE eligible_voters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identifier  text NOT NULL,        -- normalized email / member id / name key
  label       text,                 -- human-readable display
  token       text,                 -- one-time magic-link / access code
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (election_id, identifier)
);

-- ── Tenant data: checkins (per election; generalizes voter_checkins) ──
CREATE TABLE checkins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_hash  text NOT NULL,
  display_name text NOT NULL,
  verified     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (election_id, device_hash)
);

-- ── Tenant data: votes (one vote per voter per position) ──
CREATE TABLE votes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id    uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id    uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  candidate_id   uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  voter_identity text NOT NULL,     -- device_hash / email / member id / sso subject
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_vote_per_voter_per_position UNIQUE (position_id, voter_identity)
);

-- ── Audit log ──
CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid REFERENCES organizations(id) ON DELETE CASCADE,
  actor      text,
  action     text NOT NULL,
  target     text,
  meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──
CREATE INDEX idx_memberships_user     ON memberships(user_id);
CREATE INDEX idx_elections_org        ON elections(org_id);
CREATE INDEX idx_positions_election   ON positions(election_id);
CREATE INDEX idx_positions_sort       ON positions(election_id, sort_order);
CREATE INDEX idx_candidates_position  ON candidates(position_id);
CREATE INDEX idx_eligible_election    ON eligible_voters(election_id);
CREATE INDEX idx_checkins_election    ON checkins(election_id);
CREATE INDEX idx_votes_election       ON votes(election_id);
CREATE INDEX idx_votes_position       ON votes(position_id);
CREATE INDEX idx_votes_candidate      ON votes(candidate_id);
CREATE INDEX idx_audit_org            ON audit_log(org_id);

-- ============================================================
--  Privileges + Row Level Security
--
--  Control-plane tables (plans, organizations, users, memberships,
--  subscriptions) are accessed during auth/signup BEFORE an org
--  context exists, so they are app-layer guarded (no RLS).
--
--  Tenant-data tables get DB-enforced RLS: a row is visible/writable
--  only when its org_id matches the request's app.current_org GUC.
--  nullif(...,'') makes an unset GUC deny everything (fail closed).
-- ============================================================

GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'elections','positions','candidates','eligible_voters','checkins','votes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($p$
      CREATE POLICY org_isolation ON %I
        USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
        WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
    $p$, t);
  END LOOP;
END$$;
