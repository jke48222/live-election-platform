# Live Election Platform

A system for running a live election in a room: the host advances one race at a time from a laptop,
everyone votes on their phones, and results appear as the votes land. This is a rewrite of a system
built for a single student chapter, generalized so that any organization can create its own
elections without touching the code.

> **Read this before anything else.** This is an in-progress rewrite, not a finished product.
> Phases 0 through 5 of a 9-phase plan are built. Phases 6 through 9 are not started. The work lives
> on the branch `phase-1-multitenant`, which has **not** been merged: `origin/main` still contains
> the old single-tenant code that this rewrite replaces. Nothing here has ever run a real election.
> The version that did is a separate repository, `nsbe-election`.

## What problem this solves

The predecessor to this repo ran one chapter election successfully and then hit a wall written
directly into its schema: `CREATE UNIQUE INDEX single_row_state ON election_state ((true))`. The
database could physically hold exactly one election state row. One election, ever. A second club,
or the same club next year, needed an entirely separate deployment with its own database, its own
environment variables, and its own copy of the source with a different member roster compiled into
it.

Everything else in that app was hardcoded to match: a 122-name dues roster living in a JavaScript
file, a single global admin password in an environment variable, one organization's logo and colors
imported as constants, and a "Seed Database" button that inserted one specific chapter's 14 offices
and 39 candidates.

Making it usable by anyone else meant four changes that all had to happen together: a tenant model
so many organizations coexist in one database, real user accounts instead of a shared password,
configurable rules for who is allowed to vote, and an isolation boundary strong enough that a bug in
application code cannot leak one organization's ballots into another's. The last one is the reason
this repository is interesting, and it is covered in detail below.

A second motivation was dependency reduction. The original ran on a managed backend service that
supplied the database, the realtime layer, and the security policy engine. This version replaces all
three with plain PostgreSQL and about 200 lines of Node. The runtime dependency list is now exactly
`next`, `pg`, `react`, `react-dom`, and `ws`.

## What election night looks like

**From a voter's phone.** You open `/<organization>/<election>`, for example `/demo/spring-2026`.
The page loads that organization's name and accent color before you have done anything. Depending
on how the host configured the election, you are asked for a room PIN, a one-time access code, an
email address, or just your name. You type it, and you are in.

Then you wait on a holding screen. When the host launches a race, the ballot appears on your phone
by itself, with a countdown at the top that announces itself to a screen reader at 60, 30, and 10
seconds. You pick a candidate and submit. Your client waits a random 0 to 400 ms first, so eighty
phones do not all write at the same millisecond. You get a confirmation screen. When the timer runs
out, or the host locks early, every phone in the room switches to "Voting Closed" together. If your
phone sleeps, or the network drops, the WebSocket reconnects with backoff and re-subscribes, and the
page re-reads state on `visibilitychange`, so you rejoin wherever the room now is.

If the election uses a roster and your name was not on it, you sit on a "waiting for the host to
verify you" screen instead. When the host confirms you, a `checkin_verified` event reaches your
phone and the screen changes without a refresh.

**From the host's laptop.** You sign in with an email and password at `/admin`. There is no shared
admin password anymore: your authority over an election comes from your membership in the
organization that owns it, with an `owner`, `admin`, or `staff` role.

First time through, you create an organization (name, slug, type) and then an election. The election
builder asks for a title, then positions, then candidates for each position, then how voters prove
they are allowed to vote. You can upload a roster as pasted text, or have the app generate a batch
of single-use access codes to hand out at the door.

On election night you pick the next position, uncheck any candidate who has already won a higher
office, set a timer, and launch. You watch a bar chart and a pie chart while the poll is live, plus
a check-in list where you confirm or remove people. When the poll closes you either finalize the
position and move on, or, if the chart shows a tie, clear and restart the same race as a runoff,
which deletes the votes and pushes a purge event so every phone forgets it already voted. When the
last position is finalized, the election flips itself to `completed` and every phone shows a closing
screen.

## How it works

Four processes. The Next.js app serves both the voter and host UIs and all API routes. PostgreSQL
holds everything. A small standalone WebSocket gateway pushes events to phones. The browser is the
fourth.

The important structural point: **API routes never talk to the gateway.** A route writes to the
database and issues a `pg_notify` on the same connection, inside the same transaction. Postgres
delivers the notification only when that transaction commits. The gateway is listening, receives it,
and fans it out. There is no code path that can tell a phone about a write that later rolled back.

```
  voter phone                              host laptop
  components/VoterApp.js                   app/admin/page.js
       |                                        |
       | POST /api/vote                         | POST /api/state {action:"launch"}
       v                                        v
   +------------------------------------------------------+
   |  Next.js API routes (17 of them, app/api/*)          |
   |                                                      |
   |  authorizeElection(req, electionId)  -> org + RBAC   |
   |  withOrg(orgId, async db => {                        |
   |      BEGIN                                           |
   |      set_config('app.current_org', orgId, true)      |
   |      ... every query now RLS-scoped to that org ...  |
   |      pg_notify('election_events', payload)           |
   |      COMMIT      <-- the NOTIFY is delivered here    |
   |  })                                                  |
   +------------------------------------------------------+
                             |
                             v
                    PostgreSQL 16
                    13 tables, RLS on 6
                             |
                             |  LISTEN election_events
                             v
   +------------------------------------------------------+
   |  services/realtime/server.mjs  (177 lines, ws + pg)  |
   |  rooms: Map<electionId, Set<WebSocket>>              |
   |  30s ping/pong heartbeat, GET /health                |
   +------------------------------------------------------+
                             |  {type:"event", event, data}
                             v
                 only the phones in that election's room
```

Events emitted: `state_change`, `purge`, `checkin_verified`, `checkin_revoked`, from 10 call sites
across [`app/api/state/route.js`](app/api/state/route.js) and
[`app/api/checkin/route.js`](app/api/checkin/route.js).

`pg_notify` payloads are capped by Postgres at roughly 8 KB, so
[`lib/realtime.js`](lib/realtime.js) refuses anything over 7,800 bytes. Events carry a signal and
some ids; clients refetch detail over HTTP. That keeps the notification channel from becoming a data
channel.

## Tenant isolation, the part worth reading

RLS (Row Level Security) is a PostgreSQL feature that attaches a policy to a table so that a query
only sees rows the policy allows. It is the mechanism keeping one organization's elections invisible
to another. It is also very easy to configure in a way that looks correct and does nothing at all.
Three decisions in this repo are what make it real.

### 1. The application is deliberately not the table owner

A PostgreSQL table's owner bypasses that table's RLS policies. Always. This is the single most
common way people ship RLS that silently does nothing: they enable the policies, connect as the role
that created the tables, and every policy is skipped without a warning or an error.

So [`db/migrate.mjs`](db/migrate.mjs) creates a separate login role named `app` before applying any
migration, and [`db/migrations/0001_init.sql:199`](db/migrations/0001_init.sql) grants it `USAGE` on
the schema plus exactly `SELECT, INSERT, UPDATE, DELETE` on tables, and nothing more. It never owns
anything, because the migration runs as the owner. Migrations and the dev seed connect as the owner
via `DATABASE_URL`. The running application connects as `app` via `APP_DATABASE_URL`
([`lib/db.js:20`](lib/db.js)). Two connection strings, two privilege levels, and the one the web
server uses cannot bypass a policy.

### 2. The policy fails closed

Every tenant table gets the same policy, generated by a loop at
[`db/migrations/0001_init.sql:204`](db/migrations/0001_init.sql) over `elections`, `positions`,
`candidates`, `eligible_voters`, `checkins`, and `votes`:

```sql
CREATE POLICY org_isolation ON <table>
  USING      (org_id = nullif(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.current_org', true), '')::uuid);
```

Three details do the work. `current_setting(..., true)` returns NULL instead of raising when the
setting was never set, so a forgotten scope is not a 500. `nullif(..., '')` converts the empty
string that Postgres returns in some paths into NULL as well. And a comparison against NULL is not
true, so an unscoped query matches **zero rows** rather than all of them. Forgetting to open a scope
returns nothing, which is a visible bug in your own feature, not a silent cross-tenant leak.

`WITH CHECK` mirrors `USING` so the rule applies to writes too. While scoped to organization A you
cannot insert a row tagged organization B, even by putting B's id directly in the INSERT.

The scope itself is set per transaction, not per connection:
[`lib/db.js:55`](lib/db.js) calls `set_config('app.current_org', $1, true)` where the third argument
`true` means transaction-local. That matters because connections are pooled. A connection-level
setting would leak one request's tenant scope into the next request that borrows the same
connection. Transaction-local scoping ends at COMMIT or ROLLBACK.

### 3. The chicken and egg problem, and the narrow escape hatch

Here is the awkward part. An admin route receives an `election_id`. To open the RLS scope it needs
that election's `org_id`. But `org_id` lives on the `elections` row, and reading `elections` is
blocked by RLS until the scope is open. You cannot read the thing you need in order to be allowed to
read things.

The tempting fixes are all bad: connect as the owner for that one lookup (throws away the whole
guarantee), add a policy exception on `elections` (widens the hole permanently), or pass `org_id` in
from the client (trusting the caller to say which tenant they are).

[`db/migrations/0002_helpers.sql`](db/migrations/0002_helpers.sql) does it in seven lines instead:

```sql
CREATE FUNCTION election_org(p_election uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT org_id FROM elections WHERE id = p_election $$;

REVOKE ALL ON FUNCTION election_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION election_org(uuid) TO app;
```

`SECURITY DEFINER` means the function body runs with the privileges of the owner who created it, so
inside the function RLS is bypassed. The bypass is deliberately made as small as it can be:

- It returns a single UUID and nothing else. Even called with a random election id, the worst it
  leaks is which organization owns that election, which is already visible in the public URL.
- `REVOKE ALL FROM PUBLIC` then `GRANT EXECUTE TO app` means only the application role can call it.
  Postgres grants EXECUTE on new functions to PUBLIC by default, so skipping the REVOKE would hand
  every role in the database an RLS bypass.
- `SET search_path = public` pins schema resolution. Without it, a caller who can create objects
  could put a fake `elections` table earlier on their own search path and have this owner-privileged
  function read that instead.

Callers go through two thin wrappers: [`resolveElectionOrg`](lib/api-helpers.js) for public voter
reads, and [`authorizeElection`](lib/auth.js) for admin routes, which resolves the org and then
requires the session user to hold an `owner`, `admin`, or `staff` membership in it before returning.

### And it is proven, not asserted

[`db/verify-rls.mjs`](db/verify-rls.mjs) creates two throwaway organizations as the owner, then
connects as `app` and checks four things: scoped to A you see only A's election, scoped to B only
B's, with no scope at all you see zero rows, and while scoped to A an insert tagged B is rejected.
It deletes both organizations and exits non-zero on any failure.

```bash
npm run db:verify
```

That is the difference between "we use RLS" and knowing the policy is actually attached to the query
path the application uses.

## Voter eligibility

Who is allowed to vote is per election, chosen in the builder, resolved by
[`lib/eligibility.js`](lib/eligibility.js) inside the check-in transaction.

| Mode | How a voter proves eligibility | State |
| --- | --- | --- |
| `open` | Nothing. Anyone with the link, deduped by device. | Working |
| `pin` | A room PIN the host shows on the projector. | Working |
| `roster_csv` | Name must appear on an uploaded list. Matches are auto-verified, misses are let in but held for the host to confirm. | Working |
| `email_magic_link` | Email must be on an allowlist. Anything else gets a 403. | Working, but SMTP delivery is not wired |
| `access_code` | A single-use code, bound to the first device that redeems it. Reuse elsewhere gets a 403. | Working |
| `sso_oidc` | Intended for a college identity provider. | **Stub.** Returns unverified and defers to manual host confirmation. |

The `sso_oidc` case is a placeholder, not an implementation. It falls through to the same default
branch as an unknown mode at [`lib/eligibility.js:80`](lib/eligibility.js), and the file says so in
a comment at line 10. Nothing in this repo speaks OIDC.

Email is the other partial. Signup mints a verification token and writes it to the database, but no
mail is ever sent. The token is returned in the HTTP response in development only, so the flow can
be tested by hand ([`app/api/auth/signup/route.js:50`](app/api/auth/signup/route.js)).

## Vote integrity

Ordered by how much weight each layer actually carries, strongest first.

| # | Mechanism | Where | What it actually buys |
| --- | --- | --- | --- |
| 1 | `UNIQUE (position_id, voter_identity)` | [`db/migrations/0001_init.sql:160`](db/migrations/0001_init.sql) | The only mechanism that cannot be talked around. One vote per identity per position, enforced by Postgres. Vote switching is impossible. |
| 2 | SQLSTATE 23505 returned as `{ok:true, duplicate:true}` | [`app/api/vote/route.js:121`](app/api/vote/route.js) | A double tap or a retry gets a 200 and a clean UI, and an attacker probing for duplicates learns nothing from the response. |
| 3 | Server-side poll window | [`app/api/vote/route.js:65`](app/api/vote/route.js) | Status must be `voting`, the position must be the active one, and `poll_expires_at` must be in the future. A crafted POST after the timer is rejected. |
| 4 | Strict input validation | vote, checkin, state routes | Every id must match a UUID pattern, `device_hash` must match `/^[0-9a-f]{64}$/`, timer duration is clamped server side to 5 to 600 seconds. |
| 5 | Eligibility gate | [`lib/eligibility.js`](lib/eligibility.js) | Re-checked on every vote, not only at check-in. Roster, email, and SSO modes additionally require a `verified` check-in row. |
| 6 | Accounts and RBAC | [`lib/auth.js`](lib/auth.js) | scrypt password hashes (N=16384, r=8, p=1), session tokens stored as SHA-256 hashes so a database read does not yield usable cookies, sessions revocable by deleting a row. |
| 7 | Row Level Security | [`db/migrations/0001_init.sql:204`](db/migrations/0001_init.sql) | Cross-tenant reads and writes blocked by the database itself, independent of application code. See above. |
| 8 | Composite SHA-256 browser fingerprint | [`lib/fingerprint.js`](lib/fingerprint.js) | Canvas, AudioContext, and system signals hashed to a device id. **Trivially bypassable, and known to be.** See below. |
| 9 | In-memory sliding-window rate limiting | [`lib/rate-limit.js`](lib/rate-limit.js) | Real limits on a warm single instance, near useless across several instances, since the counter lives in one process's memory. |

### The fingerprint is weak and the audit says so

The predecessor's security audit filed the browser fingerprint as finding F6, critical severity, and
resolved it `WONTFIX`. Opening a different browser produces a different hash, so one person can vote
several times. Two people sharing one phone collide to the same hash, so the second is silently
blocked. That code is carried into this repo essentially unchanged, so the finding carries with it.

What changes here is that the fingerprint is no longer the only identity available. `voter_identity`
on the votes table is a text column that holds whatever the eligibility provider produced: a device
hash for `open` and `pin`, but an email or a single-use code for the modes that have a real
identifier behind them. Device hashing is the weakest option in the set rather than the only one.

## Results

Honest accounting of what has and has not been measured.

| Verified | How | Where |
| --- | --- | --- |
| RLS tenant isolation, 4 checks | Two throwaway orgs, cross-tenant reads, unset scope, WITH CHECK violation | [`db/verify-rls.mjs`](db/verify-rls.mjs) |
| Realtime room isolation, 3 checks | Two WebSocket clients on two elections, one `pg_notify`, assert only one receives it | [`services/realtime/verify-realtime.mjs`](services/realtime/verify-realtime.mjs) |
| Backend API surface, 14 checks | HTTP against a running dev server | [`scripts/smoke-backend.mjs`](scripts/smoke-backend.mjs) |
| Eligibility providers, 10 checks | All three list-backed providers including access-code device binding | [`scripts/smoke-eligibility.mjs`](scripts/smoke-eligibility.mjs) |
| Auth and sessions, 9 checks | Signup, login, session cookie, RBAC rejection | [`scripts/smoke-auth.mjs`](scripts/smoke-auth.mjs) |
| Election builder, 8 checks | Org, election, positions, candidates created over HTTP | [`scripts/smoke-builder.mjs`](scripts/smoke-builder.mjs) |
| Realtime end to end, 5 checks | Real `/api/state` launch, through `pg_notify`, gateway, and WebSocket to a subscribed client | [`scripts/smoke-realtime-e2e.mjs`](scripts/smoke-realtime-e2e.mjs) |
| **Total** | **53 assertions across 7 scripts** | |
| Source size | 5,978 lines of JS and MJS, 275 lines of SQL | repo |

**Methodology, stated plainly.** These are not tests in the usual sense. There is no test framework
in this repository: no Jest, no Vitest, no Playwright, no CI. Each script is a hand-rolled Node file
that prints check marks and exits non-zero on failure, and five of the seven require a running
`next dev`, a running realtime gateway, and a seeded Postgres before they will do anything. They are
verification scripts an author runs deliberately, not a suite that runs itself. Treat "53
assertions" as a real but modest number, and note that they cover backend behavior only. No
component, browser, or UI assertion exists anywhere in this repo.

**Not measured, and therefore not claimed:** latency. An earlier version of this README claimed
"sub-100ms" ballot delivery. That number was never measured, and its only source was a description
of the managed realtime service that this rewrite removed. There is no timing instrumentation
anywhere in this repository.

**Not measured:** concurrency. "60 to 80 concurrent voters" describes the room the predecessor was
designed for. This code has never been load tested.
[`docs/PLATFORM_PLAN.md:182`](docs/PLATFORM_PLAN.md) explicitly defers load testing to Phase 8,
which is not started.

**Not deployed.** There is no hosted instance of this repository and no URL to visit.

### The security audit in this repo does not audit this repo

[`AUDIT_FINDINGS.md`](AUDIT_FINDINGS.md) is byte for byte identical to the copy in the predecessor
repository, and it audits that codebase, not this one. It cites `lib/supabase.js`,
`lib/admin-session.js`, `lib/dues-roster.js`, and `lib/schema.sql`. **None of those files exist
here.** They were deleted in Phase 1.

It is kept because the findings are the quality bar this rewrite inherited, and because most of the
fixes were carried forward and are marked in the source with their original finding numbers (search
for `F1`, `F2`, `F8`, `F9`, `F14`, `F17`). But as a statement about the security of this code, it is
a stale artifact. **The multi-tenant rewrite has never been audited.** A security audit is Phase 8,
which is not started.

## Running it

Requires Node 18 or newer and PostgreSQL 16. Docker is the easy way to get Postgres.

**1. Start Postgres.**

```bash
docker compose up -d
```

Note what this is: [`docker-compose.yml`](docker-compose.yml) contains one service, `postgres:16`.
It is not a deployment. The full self-host stack (app, gateway, TLS terminator, object storage) is
Phase 8 and does not exist yet.

**2. Configure the environment.** Copy [`.env.example`](.env.example) to `.env.local` and adjust if
your Postgres is not the Docker one:

```bash
cp .env.example .env.local
```

The two connection strings are the isolation model described above and are not interchangeable.
`DATABASE_URL` is the owner, used only by migrations and the dev seed. `APP_DATABASE_URL` is the
least-privilege `app` role, used by everything at runtime so that RLS applies.

**3. Create the schema and demo data.**

```bash
npm install
npm run db:migrate    # creates the `app` role, applies db/migrations/*.sql in order
npm run db:seed       # plans, a demo org, a demo owner, a two-position sample election
npm run db:verify     # proves RLS isolation. Expect: ALL RLS CHECKS PASSED
```

`db:migrate` is idempotent: it records applied files in `schema_migrations` and prints
"Already up to date." on a second run. `db:seed` skips the demo organization if its slug already
exists.

**4. Run the app and the gateway.** Two terminals, both required. Without the gateway the pages
still load, but nothing updates live.

```bash
npm run dev        # terminal 1, Next.js on :3000
npm run realtime   # terminal 2, WebSocket gateway on :3001
```

- Voter ballot: `http://localhost:3000/demo/spring-2026`, room PIN `1975`
- Host dashboard: `http://localhost:3000/admin`, sign in as `demo@example.com` / `demodemo123`
- Gateway health: `http://localhost:3001/health` returns `{"ok":true,"rooms":N}`

**A successful run looks like this:** the gateway logs `LISTEN election_events` and then
`gateway on :3001`. The voter page shows a join screen with the demo organization's name and blue
accent. After joining you see a holding screen. Launch a position from the dashboard and the voter
tab flips to a ballot with a live countdown, with no refresh and no polling.

**5. Verification scripts.** All of them need step 4 running first.

```bash
npm run realtime:verify    # 3 checks, gateway room isolation
npm run smoke:backend      # 14 checks
npm run smoke:auth         #  9 checks
npm run smoke:builder      #  8 checks
npm run smoke:eligibility  # 10 checks
npm run smoke:realtime     #  5 checks, full path through a real API route
```

```bash
npm run build     # production build
npm start         # serve the production build
```

There is no lint script. Type checking happens inside `next build`.

## Project layout

```
app/
├── [org]/[election]/page.js   Canonical voter route, renders VoterApp
├── page.js                    Placeholder landing page (real one is Phase 7)
├── admin/page.js              1,797 lines: auth, org creation, election builder,
│                              eligibility config, live presenter console, results
└── api/                       17 routes
    ├── auth/                  signup, login, logout, me, verify
    ├── state/route.js         launch, lock, finalize, clear_restart,
    │                          reset_position, reset_all_results
    ├── vote/route.js          POST casts a ballot, GET returns counts (host only)
    ├── checkin/route.js       POST joins, GET/PATCH/DELETE are host tools
    ├── elections, positions, candidates, orgs, roster, results, election
    └── seed/route.js          Deprecated on purpose, returns 410

components/VoterApp.js         789 lines. Join, ballot, countdown, WebSocket
                               subscription, per-election localStorage namespacing

lib/
├── db.js                      pg pool, withOrg() transaction scoping, org lookup
├── auth.js                    scrypt hashing, DB-backed sessions, RBAC,
│                              authorizeElection() used by every admin route
├── eligibility.js             The six providers, resolved inside check-in
├── realtime.js                emit(): pg_notify on the transaction client
├── realtime-client.js         Browser WebSocket with backoff and re-subscribe
├── api-helpers.js             resolveElectionOrg(), isUuid(), clampDuration()
├── fingerprint.js             Device hash, carried over unchanged (see F6)
├── rate-limit.js              In-memory sliding window, per process
└── candidates-sort.js         Sort by last name for ballot display

db/
├── migrations/0001_init.sql   13 tables, privileges, RLS on 6 tenant tables
├── migrations/0002_helpers.sql  election_org(), the narrow SECURITY DEFINER lookup
├── migrations/0003_auth.sql   user_sessions, email verification token
├── migrations/0004_eligibility.sql  claimed_by_device, binds a code to one device
├── migrate.mjs                Runner. Creates the `app` role, applies in order
├── seed.mjs                   Dev fixtures only. No real organization data
└── verify-rls.mjs             The 4-check isolation proof

services/realtime/
├── server.mjs                 The gateway: ws + LISTEN/NOTIFY, rooms, heartbeat
└── verify-realtime.mjs        3-check room isolation proof

scripts/                       5 HTTP smoke scripts, 46 checks total
docs/PLATFORM_PLAN.md          The 9-phase plan this repo is executing
AUDIT_FINDINGS.md              Stale. Audits the predecessor. See Results
docker-compose.yml             Postgres only. Not a deployment
```

## Status

Five commits, all dated 10 June 2026, on the branch `phase-1-multitenant`. That branch is **not
merged**, and `origin/main` still holds the pre-rewrite Supabase code, so cloning this repo and
staying on the default branch gives you the old application. Everything described in this README is
on `phase-1-multitenant`.

Against the roadmap in [`docs/PLATFORM_PLAN.md`](docs/PLATFORM_PLAN.md):

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundation: Docker Postgres, migration runner, `pg` data layer | Done |
| 1 | Multi-tenant schema, RLS, all single-chapter hardcoding removed | Done |
| 2 | Self-hosted auth, organizations, per-org RBAC | Done |
| 3 | Realtime gateway replacing the managed broadcast service | Done |
| 4 | Election builder and canonical `/<org>/<election>` routing | Done |
| 5 | Pluggable eligibility providers | Done except `sso_oidc` |
| 6 | Billing and entitlements | **Not started** |
| 7 | Marketing site, brand, sign-up funnel | **Not started** |
| 8 | Hardening, load test, security audit, backups, monitoring | **Not started** |
| 9 | Business and legal | **Not started** |

Known gaps, in the order I would fix them:

- **There is no entitlement engine.** The plan describes tiers gated by a `plans.limits` JSON blob
  checked at the API boundary. What exists is two empty tables (`plans`, `subscriptions`) and four
  plan rows the dev seed inserts. **Zero code reads or enforces a limit anywhere.** Nothing is
  gated. That is Phase 6, and it is not started.
- **The rewrite has never been security audited**, and the audit file that ships with it describes a
  different codebase. Detailed above.
- **No test framework and no CI.** The 53 assertions are hand-rolled scripts that need a live server
  and database. The highest-value addition would be making them runnable against an ephemeral
  database in CI so `db/verify-rls.mjs` guards the isolation model on every commit, since that is
  the one property whose silent failure would be worst.
- **`sso_oidc` is an explicit stub**, and it is the feature the college tier in the plan is built
  around.
- **SMTP is not wired**, so email verification and magic links cannot actually reach a voter.
- **`docker-compose.yml` is a database, not a stack.** Self-hosting the app today means running
  `next start` and `services/realtime/server.mjs` yourself and putting TLS in front of both.
- **Rate limiting is still per process**, which is the same limitation the predecessor had and gets
  worse, not better, on a multi-instance deployment.
- **Never load tested.** The concurrency figure in the plan is a design target.

**Prior version.** The single-tenant application this replaces is in a separate repository,
`nsbe-election`. It is the one that actually ran a live chapter election. It is also the one whose
schema allows exactly one election to exist.

---

Jalen Edusei, [jalenedusei.com](https://www.jalenedusei.com),
[github.com/jke48222](https://github.com/jke48222)
