# Universal Live Election Platform — Architecture & Roadmap

**Status:** Draft for approval · **Date:** 2026-06-10
**Goal:** Transform the single-tenant NSBE UGA election app into a universal, multi-tenant, fully self-hosted live-election platform that any organization, college, or individual can use. Free in beta, ~$20/mo at full release.

This document is the contract for the build. Nothing in the codebase changes until the decisions in §2 and the roadmap in §8 are approved.

---

## 1. Product vision

A best-in-class **live, presenter-paced election platform** (the current app's standout feature) generalized into a SaaS that anyone can sign up for and run their own elections on — with no hardcoded organization data, configurable branding, flexible voter eligibility, and self-serve onboarding.

**Three customer segments** (all confirmed in scope):

| Segment | Needs | Tier |
|---|---|---|
| **Individuals** | One-off polls/elections, open or email-link voting, no roster, lightweight | Free / low-cost |
| **Organizations / clubs** | Roster upload, member/dues eligibility, branding, multiple admins (NSBE-like) | ~$20/mo |
| **Colleges / universities** | Student-gov scale, SSO / .edu verification, high concurrency, audit exports | Custom / Enterprise |

**Two election modes:**
- **Live presenter-paced** (the current model): host advances position-by-position, synchronized countdown, real-time results. This is the differentiator.
- **Scheduled window** (new): election opens at T1, closes at T2, voters vote anytime in between. Needed for college/remote use.

---

## 2. The core decision: "fully self-hosted, zero third-party dependencies"

You chose **maximum independence**: replace Supabase entirely with a self-contained stack. This document commits to that. What it actually means, and the honest tradeoffs:

### What gets removed
Supabase today provides **four** things this app depends on. All must be rebuilt/self-operated:
1. **Managed Postgres** → self-managed PostgreSQL (Docker / VPS).
2. **Realtime Broadcast** (the live-sync engine) → **self-hosted WebSocket gateway** backed by Postgres `LISTEN/NOTIFY`. *This is the biggest single lift.*
3. **Row Level Security** → keep Postgres-native RLS (it's just Postgres, not Supabase) driven by a per-request `app.current_org` session variable, plus app-layer guards.
4. **(Implicitly) managed backups, pooling, dashboard** → self-operated: `pgBouncer` for pooling, `pg_dump`/WAL for backups, your own admin tooling.

### The unavoidable realities (not negotiable, just true)
- **Payments need a processor.** You cannot touch raw card numbers without PCI scope. Stripe/PayPal cost **$0 fixed** (per-transaction fees only). Plan: build subscription/entitlement logic ourselves; put the payment rail behind a `PaymentProvider` interface; run beta in **manual/invoice mode = literally $0**; add a Stripe adapter at paid launch. You stay "self-built" everywhere that matters and owe nothing until you're collecting money.
- **Email deliverability.** Magic links / verification emails from a self-run SMTP land in spam. Make SMTP **configurable** (the operator points it at any mail host, including their own). Zero hard dependency, pragmatic default.
- **Real costs that remain:** a domain (~$10–15/yr) and a server/VPS to run it on. That's the floor for any self-hosted SaaS.
- **SSO for colleges** uses the *customer's* identity provider (Google Workspace / Azure AD / SAML). That's their dependency, not ours — acceptable and expected.

### Why this still works
Shared, multi-tenant code that *also* runs as a single-org self-hosted instance. One codebase, deployed by us as the SaaS **and** deployable by a security-conscious college on their own hardware. That duality is a selling point.

---

## 3. Target tech stack (zero third-party)

| Concern | Today | Target |
|---|---|---|
| App framework | Next.js 14 (App Router) on Vercel | **Next.js 14, self-hosted Node** (runs anywhere; drop Vercel lock-in) |
| Database | Supabase Postgres | **PostgreSQL** (self-managed, Dockerized) |
| DB access | `@supabase/supabase-js` | **`pg` + a typed query layer** (Kysely or Drizzle) — no Supabase SDK |
| Realtime | Supabase Broadcast | **`ws` WebSocket gateway + Postgres `LISTEN/NOTIFY`** fan-out |
| Tenant isolation | Supabase RLS | **Postgres RLS** via `SET LOCAL app.current_org` + app guards |
| Auth | Env admin password + HMAC cookie | **Self-built auth**: argon2id passwords, httpOnly session cookies, email verification, optional TOTP; OIDC/SAML for college SSO |
| Authorization | Single admin | **RBAC**: org `owner` / `admin` / `staff`; platform `superadmin` |
| Billing | none | **Self-built entitlement engine** + pluggable `PaymentProvider` (manual → Stripe) |
| File/logo storage | none (static SVG) | **S3-compatible (self-hosted MinIO)** or local disk |
| Email | none | **Pluggable SMTP** (nodemailer) |
| Deploy | Vercel | **Docker Compose**: app + postgres + ws-gateway + Caddy (TLS) + MinIO |
| Observability | none | structured logs + health checks + Prometheus-friendly metrics |

**Repo shape** (evolve the existing single Next app, don't rewrite):
```
/app            Next.js (voter UI, admin UI, marketing site, API routes)
/services/realtime   standalone WS gateway (Node, ws + pg LISTEN/NOTIFY)
/lib            shared: db, auth, entitlements, eligibility providers, realtime client
/db             migrations (numbered SQL), seed for local dev only
/docker         Compose, Dockerfiles, Caddyfile
/docs           this plan + runbooks
```

---

## 4. Multi-tenant data model (replaces the singleton)

The fatal single-tenant assumption today is `CREATE UNIQUE INDEX single_row_state ON election_state ((true))` — **exactly one election can exist, ever**. The whole model is rebuilt around `organization` → `election` → `position` → `candidate`, with everything tenant-scoped.

```
organizations         id, slug, name, type(individual|club|college), branding(jsonb),
                      plan_id, subscription_status, created_at
users                 id, email(unique), password_hash, name, email_verified, totp_secret?, created_at
memberships           id, org_id, user_id, role(owner|admin|staff)      -- a user can join many orgs
plans                 id, key, name, price_cents, interval, limits(jsonb)  -- feature/usage caps
subscriptions         id, org_id, plan_id, status, current_period_end, provider, provider_ref

elections             id, org_id, title, description,
                      mode(live_presenter|scheduled_window),
                      status(draft|scheduled|waiting|voting|locked|completed),
                      active_position_id, poll_expires_at,
                      opens_at?, closes_at?,                 -- scheduled mode
                      eligibility_mode, settings(jsonb), created_at
positions             id, election_id, title, sort_order, max_winners, is_completed   -- was "roles"
candidates            id, position_id, name, bio?, photo_url?, is_active, sort_order

eligible_voters       id, election_id, identifier, token, label?, used_at?   -- roster / email-link / codes
checkins              id, election_id, device_hash, display_name, verified, created_at
votes                 id, election_id, position_id, candidate_id, voter_identity, created_at,
                      UNIQUE(position_id, voter_identity)
audit_log             id, org_id, actor, action, target, meta(jsonb), created_at
```

**Key generalizations from NSBE-specific → universal:**
- `roles` → `positions` (with `max_winners` for multi-seat races).
- The NSBE dues roster → a generic `eligible_voters` table fed by **pluggable eligibility providers** (§5).
- `election_state` singleton → per-row state columns on `elections` (each org runs many, concurrently).
- Branding (logo/colors/name) moves from `lib/branding.js` constants → `organizations.branding` JSON, themed at runtime.
- `voter_identity` is provider-dependent: device hash (open/PIN), email (magic link), member id (roster), or SSO subject (college).

**RLS pattern (Postgres-native, no Supabase):** every tenant table has a policy `org_id = current_setting('app.current_org')::uuid`. Each API request opens a transaction, runs `SET LOCAL app.current_org = $orgId` after authenticating, so the DB enforces isolation even if app code has a bug.

---

## 5. Eligibility as pluggable providers

The single most NSBE-coupled piece (`lib/dues-roster.js`, `/api/checkin`) becomes a clean interface so any org configures how voters are gated:

| Provider | Use case | How it works |
|---|---|---|
| `open` | quick individual poll | anyone with the link; device-hash dedupe |
| `pin` | in-person club meeting | room PIN to join (current behavior, generalized) |
| `roster_csv` | NSBE-style dues/members | upload name/ID list → `eligible_voters`; match on check-in |
| `email_magic_link` | remote org vote | allowlist of emails; one-time tokened link per voter |
| `access_code` | anonymous-but-controlled | pre-generated unique codes handed out |
| `sso_oidc` / `saml` | colleges | authenticate against customer IdP, restrict by domain/group |

Interface: `verifyEligibility(election, claim) → { eligible, voter_identity, reason }`. The current dues-roster logic becomes the `roster_csv` implementation, de-hardcoded.

---

## 6. Onboarding flow (self-serve, no NSBE data)

```
Sign up (email+password, verify email)
  → Create organization (name, slug, type: individual | club | college)
  → Choose plan (Free Beta selected by default)
  → Branding (logo upload, primary color, display name)  [skippable]
  → Election wizard:
        1. Title + mode (live presenter | scheduled window)
        2. Positions (add titles, seats each)
        3. Candidates per position (name, optional bio/photo) — or "open nominations"
        4. Eligibility (pick a provider from §5; upload roster / set PIN / etc.)
        5. Review → Save as draft
  → Launch (live: presenter console / scheduled: set open & close times)
  → Share voter link / QR
```
Replaces the current "Seed Database" button (which inserts NSBE's 14 roles / 39 candidates) entirely.

---

## 7. Subscription tiers (starting point)

| Tier | Price | Limits / Features |
|---|---|---|
| **Free Beta** | $0 (beta) | All features unlocked, "powered by" badge, used to gather feedback |
| **Individual** | free or ~$5/mo | 1 active election, ≤ N voters, `open`/`pin`/`email` eligibility, no custom branding |
| **Organization** | **~$20/mo** | Unlimited elections, roster + email eligibility, full branding, up to 3 admins, result exports |
| **College / Enterprise** | custom | SSO/SAML, high concurrency, audit logs, multiple orgs, SLA, self-host license |

Enforced by the **entitlement engine**: `plans.limits` JSON (`max_active_elections`, `max_voters`, `branding`, `sso`, `seats`, …) checked at the API boundary. Beta = everything on; flip limits on at paid launch without code changes.

---

## 8. Phased roadmap

Each phase is independently shippable and leaves the app working. Rough sizing assumes focused iterations, not calendar promises.

| Phase | Outcome | Key work |
|---|---|---|
| **0 — Foundation** *(this doc)* | Decisions locked, repo restructured, local Docker Postgres + Next running off `pg` instead of Supabase SDK for one read path (proof) | Compose file, db client, migration runner |
| **1 — Multi-tenant data model** | New schema with orgs/elections/positions; **all NSBE hardcoding removed**; per-election state replaces singleton; Postgres RLS | migrations, rewrite `/api/state`, `/api/candidates`, results to be election-scoped |
| **2 — Self-built auth & orgs** | Sign up / log in / verify email; org creation; RBAC memberships; admin password env var gone | auth lib (argon2id, sessions), `/api/auth/*`, org context middleware |
| **3 — Self-hosted realtime** | Supabase Broadcast replaced by WS gateway + `LISTEN/NOTIFY`; sub-second live sync preserved; drop `@supabase/supabase-js` | `/services/realtime`, client reconnect logic, load test |
| **4 — Election builder + onboarding** | Wizard UI; create positions/candidates/eligibility from scratch; "Seed" button removed | builder pages, draft elections |
| **5 — Pluggable eligibility** | All §5 providers; dues-roster refactored into `roster_csv`; CSV upload UI | eligibility interface + providers |
| **6 — Billing & entitlements** | Tiers, feature gating, `PaymentProvider` interface, manual/invoice mode; Stripe adapter stubbed | entitlement engine, billing pages |
| **7 — Marketing site & brand** | Landing, pricing, docs, sign-up funnel; the "official business/website" front door | `/app/(marketing)`, domain, copy |
| **8 — Hardening & ops** | Load test (target the old 60–80 concurrent, scale to 1000s), security audit v2, backups, monitoring, rate limits per-tenant | runbooks, CI, observability |
| **9 — Business/legal** | Entity formation, ToS, privacy policy, DPA for colleges, domain + email, payment go-live | non-code; checklist |

**Critical path / risk order:** Phase 1 (de-NSBE-ify + tenancy) and Phase 3 (realtime) are the two hard, foundational lifts — everything else layers on cleanly once those land. Recommend doing 1 → 2 → 3 before any UI polish or billing.

---

## 9. What changes in the current code (file-level)

| Current file | Fate |
|---|---|
| `lib/schema.sql` | **Replaced** by numbered migrations in `/db`; singleton index deleted |
| `lib/supabase.js` | **Removed**; new `lib/db.js` (pg pool) + `lib/realtime-client.js` |
| `lib/branding.js` | **Removed**; branding becomes per-org runtime theme |
| `lib/seed-data.mjs`, `lib/seed.mjs`, `/api/seed` | **Removed** (no hardcoded NSBE slate); dev-only seed in `/db` |
| `lib/dues-roster.js`, `/api/checkin*` | **Refactored** into the `roster_csv` eligibility provider |
| `/api/state` | **Rewritten** election-scoped + tenant-guarded; per-row state |
| `/api/vote`, `/api/results`, `/api/candidates` | **Rewritten** election-scoped |
| `lib/admin-session.js`, `lib/rate-limit.js` | **Kept & extended** (good foundations: HMAC sessions, per-tenant limits) |
| `app/page.js` (voter) | **Refactored** to load election by slug + provider-driven eligibility |
| `app/admin/page.js` | **Split** into org dashboard + election builder + live presenter console |

The security work captured in `AUDIT_FINDINGS.md` (vote-dedupe via DB unique constraint, HMAC sessions, rate limiting, input validation) is **preserved and generalized** — it's the quality bar the platform inherits, not throwaway.

---

## 10. Open decisions for you (can defer past Phase 1)

1. **Query layer:** Kysely (lightweight, SQL-first) vs Drizzle (more ORM-like). *Recommend Kysely* for a SQL-heavy realtime app.
2. **Brand/business name** for the universal product (NSBE name is retired). Needed by Phase 7.
3. **Pricing finalization** for Individual/College tiers (Org = $20/mo is set).
4. **Self-host distribution:** do you want to *sell* a self-host license to colleges, or keep it SaaS-only? Affects Phase 9.
5. **Payment processor at launch:** Stripe (recommended, $0 fixed) vs PayPal vs manual-invoice-only.

---

## 11. Recommended immediate next step

Approve this plan, then start **Phase 1**: stand up local Docker Postgres, write the multi-tenant migrations, and rewrite the four API routes to be election-scoped with zero NSBE hardcoding. That single phase proves the whole re-platforming and makes the app genuinely multi-org. I can begin it on your word.
