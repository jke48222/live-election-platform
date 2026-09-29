# Live Election Platform

[![License](https://img.shields.io/github/license/jke48222/live-election-platform)](LICENSE) ![Top language](https://img.shields.io/github/languages/top/jke48222/live-election-platform) ![framework](https://img.shields.io/badge/framework-Next.js-black) ![database](https://img.shields.io/badge/database-PostgreSQL%2C%20row----level%20security-blue)

A system for running a live election in a room: the host advances one race at a time from a laptop,
everyone votes on their phones, and results appear as the votes land. This is a rewrite of a system
built for a single student organization, generalized so that any organization can create its own
elections without touching the code.

> **Read this before anything else.** This is an in-progress rewrite, not a finished product.
> Phases 0 through 5 of a 9-phase plan are built, and phases 6 through 9 are not started (see
> [Status](#status)). The first, single-tenant version ran a real University of Georgia student
> organization's officer election in spring 2026. This rewrite has not run a real election yet. It
> has never been security audited or load tested, and there is no hosted instance.

## What problem this solves

The predecessor to this repo ran one election successfully and then hit a wall written directly
into its schema: `CREATE UNIQUE INDEX single_row_state ON election_state ((true))`. The database
could physically hold exactly one election state row. One election, ever. A second club, or the same
club next year, needed an entirely separate deployment with its own database, its own environment
variables, and its own copy of the source with a different member roster compiled into it.

Everything else in that app was hardcoded to match. A 122-name dues roster lived in a JavaScript
file, and a single global admin password lived in an environment variable. One organization's logo
and colors were imported as constants, and a "Seed Database" button inserted one specific
organization's 14 offices and 39 candidates.

Making it usable by anyone else meant four changes that all had to happen together. It needed a
tenant model so many organizations coexist in one database, real user accounts instead of a shared
password, and configurable rules for who is allowed to vote. It also needed an isolation boundary
strong enough that a bug in application code cannot leak one organization's ballots into another's.
The last one is the reason this repository is interesting, and it is covered in detail below.

A second motivation was dependency reduction. The original ran on a managed backend service that
supplied the database, the realtime layer, and the security policy engine. This version replaces all
three with plain PostgreSQL and a small Node WebSocket gateway. The runtime dependency list is
exactly `next`, `pg`, `react`, `react-dom`, and `ws`.

## What election night looks like

**From a voter's phone.** You open `/<organization>/<election>`, for example `/demo/spring-2026`.
The page loads that organization's name and accent color before you have done anything. Depending
on how the host configured the election, you are asked for a room PIN, a one-time access code, an
email address, or just your name. You type it, and you are in.

Then you wait on a holding screen. When the host launches a race, the ballot appears on your phone
by itself, with a countdown at the top that announces itself to a screen reader at 60, 30, and 10
seconds. The countdown runs on the server's clock, so a phone whose clock is off still closes on
time. You pick a candidate and submit. Your client waits a random 0 to 400 ms first, so eighty
phones do not all write at the same millisecond. You get a confirmation screen. When the timer runs
out, or the host locks early, every phone in the room switches to "Voting closed" together.

If your phone sleeps or the network drops, the page notices within about 20 seconds (it pings the
gateway every 15), shows "Reconnecting, updates may be delayed", reconnects, and re-reads the room
over HTTP, so you land wherever the room now is. Reloading the page or pressing Back keeps you
checked in.

If the election uses a roster and your name was not on it, you sit on a "waiting for the host to
confirm you can vote" screen instead. When the host confirms you, a `checkin_verified` event reaches
your phone and the screen changes without a refresh.

**From the host's laptop.** You sign in with an email and password at `/admin`. There is no shared
admin password anymore: your authority over an election comes from your membership in the
organization that owns it, with an `owner`, `admin`, or `staff` role.

First time through, you create an organization (name, slug, type) and then an election. The election
builder asks for a title, then positions, then candidates for each position, then how voters prove
they are allowed to vote. You can upload a roster as pasted text, or have the app generate a batch
of single-use access codes to hand out at the door. The console shows the room PIN.

On election night you pick the next position, uncheck any candidate who has already won a higher
office, set a timer, and launch. You watch a bar chart and a pie chart while the poll is live, plus
a check-in list that updates as people arrive, where you confirm or remove them. When the poll
closes you either finalize the position and move on, or, if the chart shows a tie, clear and restart
the same race as a runoff, which deletes the votes and pushes a purge event so every phone forgets it
already voted. When the last position is finalized, the election flips itself to `completed`, every
phone shows a closing screen, and the console shows the final results. You can still reset one race
and run it again after that.

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
   |  Next.js API routes (18 of them, app/api/*)          |
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
                    14 tables, RLS on 8
                             |
                             |  LISTEN election_events
                             v
   +------------------------------------------------------+
   |  services/realtime/server.mjs + gateway.mjs (ws, pg) |
   |  rooms: Map<electionId, Set<WebSocket>>              |
   |  LISTEN reconnect with backoff, GET /health          |
   +------------------------------------------------------+
                             |  {type:"event", event, data}
                             v
                 only the phones in that election's room
```

Events emitted: `state_change`, `purge`, `checkin_created`, `checkin_verified`, `checkin_revoked`,
`checkin_failures` and `settings_changed`, from six route files under [`app/api`](app/api).
`checkin_created` and `checkin_failures` go to the host's sockets only.

`pg_notify` payloads are capped by Postgres at roughly 8 KB, so
[`lib/realtime.js`](lib/realtime.js) refuses anything over 7,800 bytes. Events carry a signal and
some ids; clients refetch detail over HTTP. That keeps the notification channel from becoming a data
channel. `emit()` also refuses any payload with a field named like a credential (`pin`, `code`,
`token`, `password`, `email` and a few more), so a broadcast cannot carry one by mistake. Check-in
events carry a one-way tag, never the device id a voter uses to vote.

NOTIFY is fire and forget: anything sent while the gateway's LISTEN connection is down is lost. So
when that connection drops, the gateway tells every socket `live:false` and clients poll; when it
comes back they get `live:true` and a `resync` event and refetch.

In production the gateway also requires a short-lived signed ticket to subscribe (the app issues it
at `POST /api/realtime/ticket`, or with the check-in), checks the browser `Origin` against an
allowlist, and caps frame size, frame rate, and connections per IP.

## Tenant isolation, the part worth reading

RLS (Row Level Security) is a PostgreSQL feature that attaches a policy to a table so that a query
only sees rows the policy allows. It is the mechanism keeping one organization's elections invisible
to another. It is also easy to configure in a way that looks correct and does nothing at all.
Four decisions in this repo are what make it real.

### 1. The application is deliberately not the table owner

A PostgreSQL table's owner bypasses that table's RLS policies. Always. This is the single most
common way people ship RLS that silently does nothing: they enable the policies, connect as the role
that created the tables, and every policy is skipped without a warning or an error.

So [`db/migrate.mjs`](db/migrate.mjs) creates a separate login role named `app` before applying any
migration, and [`db/migrations/0001_init.sql:199`](db/migrations/0001_init.sql) grants it `USAGE` on
the schema plus exactly `SELECT, INSERT, UPDATE, DELETE` on tables, and nothing more. It never owns
anything, because the migration runs as the owner. Migrations and the dev seed connect as the owner
via `DATABASE_URL`. The running application connects as `app` via `APP_DATABASE_URL`
([`lib/db.js:27`](lib/db.js)). Two connection strings, two privilege levels, and the one the web
server uses cannot bypass a policy.

### 2. A deploy that gets this wrong refuses to start

Two connection strings are easy to mix up, so the app does not trust the configuration:

- The web server and the gateway never fall back to `DATABASE_URL`. `next start` exits at once
  without `APP_DATABASE_URL` or a `REALTIME_SECRET` of 32 or more characters
  ([`scripts/production-env.cjs`](scripts/production-env.cjs), called from
  [`next.config.js`](next.config.js)). The gateway does the same, and it treats every `NODE_ENV`
  other than `development` as production. CI starts each server without these settings and fails
  if one comes up.
- Before its first query, [`lib/db.js`](lib/db.js) asks Postgres what the connected role can do,
  and refuses a role that is a superuser, has `BYPASSRLS`, or owns (or inherits ownership of) any
  table under RLS. The gateway runs the same check at startup. Pointing `APP_DATABASE_URL` at the
  owner by mistake gives an error, not a working app with no isolation.
- `db:migrate` needs `APP_DB_PASSWORD` outside development, and it only changes the `app` role's
  password when that variable is given.

The tables do not use `FORCE ROW LEVEL SECURITY`. The lookup in decision 4 below depends on the
owner reading `elections`, and FORCE would break it on a managed Postgres where the owner is not a
superuser. The role check above is the guard instead, and `db:verify` tests it.

### 3. The policy fails closed

Every tenant table gets the same policy. A loop at
[`db/migrations/0001_init.sql:207`](db/migrations/0001_init.sql) adds it to `elections`,
`positions`, `candidates`, `eligible_voters`, `checkins`, and `votes`.
[`0005_ballot_secrecy.sql`](db/migrations/0005_ballot_secrecy.sql) adds it to `ballots_cast` and
`audit_log`, and [`0007_vote_tallies.sql`](db/migrations/0007_vote_tallies.sql) to
`vote_tallies`, which replaced the `votes` table with a view over it:

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
[`lib/db.js:201`](lib/db.js) calls `set_config('app.current_org', $1, true)` where the third
argument `true` means transaction-local. That matters because connections are pooled. A
connection-level setting would leak one request's tenant scope into the next request that borrows
the same connection. Transaction-local scoping ends at COMMIT or ROLLBACK.

### 4. The chicken and egg problem, and the narrow escape hatch

Here is the awkward part. An admin route receives an `election_id`. To open the RLS scope it needs
that election's `org_id`. But `org_id` lives on the `elections` row, and reading `elections` is
blocked by RLS until the scope is open. You cannot read the thing you need to be allowed to read
things.

The tempting fixes are all bad. Connecting as the owner for that one lookup throws away the whole
guarantee. A policy exception on `elections` widens the hole permanently. Passing `org_id` in from
the client trusts the caller to say which tenant they are.

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

[`db/verify-rls.mjs`](db/verify-rls.mjs) creates two throwaway organizations as the owner, puts one
row per organization in each of the eight tenant tables, then connects as `app`. For every table it
checks that RLS is on and the policy exists, that each organization sees only its own row, that no
scope sees zero rows, and that inserting, updating, deleting, or moving a row across organizations
is refused. It also checks the connection rules from decision 2 for the web server and the
gateway, ballot secrecy (below), that the per-voter lookups have indexes to use, and, in a scratch
database, an upgrade from the committed single-tenant data format. That is 128 checks. It deletes its test organizations and exits non-zero on any failure.

```bash
npm run db:verify
```

That is the difference between "we use RLS" and knowing the policy is actually attached to the query
path the application uses. CI runs it on every push to `main`.

## Voter eligibility

Who is allowed to vote is per election, chosen in the builder, resolved by
[`lib/eligibility.js`](lib/eligibility.js) inside the check-in transaction.

| Mode | How a voter proves eligibility | State |
| --- | --- | --- |
| `open` | Nothing. Anyone with the link, one check-in per browser. | Working |
| `pin` | A room PIN (6 to 8 digits) the host shows on the projector. The host can change it during a poll. | Working |
| `roster_csv` | Name must appear on an uploaded list. A match claims that entry for one device. Misses are let in but held for the host to confirm. | Working |
| `email_magic_link` | Email must be on an allowlist, and it is bound to the first device that uses it. | Working, but no link is emailed (see below) |
| `access_code` | A single-use code, bound to the first device that redeems it. | Working |
| `sso_oidc` | Intended for a college identity provider. | **Stub.** Returns unverified and defers to manual host confirmation. |

In roster, email, and code modes one list entry backs one ballot per race. A person who moves to a
new phone keeps the same ballot, so they cannot vote twice in a race by switching devices.

What each mode does not protect against:

- **PIN and open modes have no per-person identity.** Anyone with the PIN or the link can check in
  from several browsers and vote once from each.
- **Email mode sends no link yet.** Knowing an address on the list is the proof. SMTP is not wired.
- **Roster and email check-in tell the caller whether a name or email is on the list.** Anyone
  with the voter link can test names. A host can see who claimed an entry and remove that check-in,
  which frees the entry.

The `sso_oidc` case is a placeholder, not an implementation. It falls through to the same default
branch as an unknown mode at [`lib/eligibility.js:125`](lib/eligibility.js), and the file says so in
a comment at line 12. Nothing in this repo speaks OIDC.

Signup mints an email verification token and writes it to the database, but no mail is ever sent.
The link is returned in the HTTP response in development only, so the flow can be tested by hand
([`app/api/auth/signup/route.js:63`](app/api/auth/signup/route.js)).

## Vote integrity

Ordered by how much weight each layer actually carries, strongest first.

| # | Mechanism | Where | What it actually buys |
| --- | --- | --- | --- |
| 1 | `UNIQUE (position_id, voter_ref)` on `ballots_cast`, written with the vote by `cast_ballot()` | [`0005_ballot_secrecy.sql`](db/migrations/0005_ballot_secrecy.sql), [`0007_vote_tallies.sql`](db/migrations/0007_vote_tallies.sql) | The only mechanism that cannot be talked around. One vote per voter per position, enforced by Postgres. Vote switching is impossible. |
| 2 | Ballot secrecy | [`0007_vote_tallies.sql`](db/migrations/0007_vote_tallies.sql) | `ballots_cast` records who voted. Choices are kept only as one counter per candidate (`vote_tallies`), and every ballot in a race updates all of that race's counters together. The admin UI, the API, SQL queries by any role and `pg_dump` backups cannot match a named check-in to a choice, and `db:verify` runs that attack. Old row versions until `VACUUM`, the WAL, physical backups and a superuser with `pageinspect` can still show the order of changes, so run `VACUUM vote_tallies` after each race and keep WAL archives and physical backups secret. |
| 3 | A repeat vote returns `{ok:true, duplicate:true, code:"already_voted"}` | [`app/api/vote/route.js:137`](app/api/vote/route.js) | A double tap or a retry gets a 200, and the phone says "This device already voted in this race." |
| 4 | Server-side poll window | [`app/api/vote/route.js:66`](app/api/vote/route.js) | Status must be `voting`, the position must be the active one, and `poll_expires_at` must be in the future. A crafted POST after the timer is rejected. The vote reads the election row `FOR SHARE`, so it cannot interleave with a lock or finalize. |
| 5 | Strict input validation | vote, checkin, state routes | Every id must match a UUID pattern, `device_hash` must match `/^[0-9a-f]{64}$/`, timer duration is clamped server side to 10 to 300 seconds, the same range the console accepts. Lock, finalize and restart name the poll they mean and get a 409 if it changed. |
| 6 | Eligibility gate | [`lib/eligibility.js`](lib/eligibility.js) | Re-checked on every vote, not only at check-in. Roster, email, and SSO modes also require a `verified` check-in row. |
| 7 | Accounts and RBAC | [`lib/auth.js`](lib/auth.js) | scrypt password hashes (N=16384, r=8, p=1), session tokens stored as SHA-256 hashes so a database read does not yield usable cookies, sessions revocable by deleting a row. Login takes the same time for an unknown email. |
| 8 | Row Level Security | [`db/migrations/0001_init.sql:207`](db/migrations/0001_init.sql) | Cross-tenant reads and writes blocked by the database itself, independent of application code. See above. |
| 9 | A random id per browser | [`lib/fingerprint.js`](lib/fingerprint.js) | 32 random bytes kept in `localStorage`. **Clearing site data or opening another browser gives a new id.** See below. |
| 10 | In-memory rate limiting | [`lib/checkin-guard.js`](lib/checkin-guard.js), [`lib/login-guard.js`](lib/login-guard.js) | Wrong room PINs, codes and passwords are counted per device and per IP (per account only when no IP is known), so a stranger cannot lock anyone else out. The per-election count only slows wrong answers down and alerts the host; it never blocks check-in. Per-IP limits need `TRUSTED_PROXY_HOPS`, which says which proxy header to trust. Without it a client can dodge the per-device limit by making up device ids. Real limits on one instance, near useless across several, since the counters live in one process's memory. |

### The device id is weak on purpose

The predecessor hashed canvas, audio, and screen signals into a "fingerprint". Two identical phones
got the same hash, so the second voter was silently blocked, and rotating a phone could change it.
This version gives each browser a random id instead. That fixes the collisions, and it is honest
about what a device id is: in PIN and open modes, a person with two browsers is two voters.

The modes with a real identifier behind them do not rely on it. In roster, email, and code modes the
ballot is recorded against the list entry, not the device, so one entry gets one ballot per race
however many phones try.

## Results

What has and has not been measured.

| Verified | How | Where |
| --- | --- | --- |
| RLS tenant isolation, 128 checks | Eight tenant tables, two throwaway orgs, cross-tenant reads and writes, unset scope, connection rules for the app and the gateway, ballot secrecy including the xmin and row-order attack run as the owner, lookup indexes, and an upgrade from the committed schema | [`db/verify-rls.mjs`](db/verify-rls.mjs), [`db/verify-upgrade.mjs`](db/verify-upgrade.mjs) |
| Realtime gateway, 16 checks | Room isolation, no device id in any frame, frame size limit, tickets, LISTEN loss and resync against real Postgres | [`services/realtime/verify-realtime.mjs`](services/realtime/verify-realtime.mjs) |
| Backend API surface, 14 checks | HTTP against a running server | [`scripts/smoke-backend.mjs`](scripts/smoke-backend.mjs) |
| Eligibility providers, 10 checks | All three list-backed providers including access-code device binding | [`scripts/smoke-eligibility.mjs`](scripts/smoke-eligibility.mjs) |
| Auth and sessions, 9 checks | Signup, login, session cookie, RBAC rejection | [`scripts/smoke-auth.mjs`](scripts/smoke-auth.mjs) |
| Election builder, 8 checks | Org, election, positions, candidates created over HTTP | [`scripts/smoke-builder.mjs`](scripts/smoke-builder.mjs) |
| Realtime end to end, 15 checks | Voter ticket from check-in, admin ticket from `/api/realtime/ticket`, forged and missing tickets refused, then a real `/api/state` launch through `pg_notify` and the gateway to both sockets | [`scripts/smoke-realtime-e2e.mjs`](scripts/smoke-realtime-e2e.mjs) |
| Guards, 32 checks | 120 wrong room PINs never block the right one, one guessing device is refused, stale tabs cannot finalize a runoff, two-seat results, the voter list is fixed during a poll, strangers cannot lock the owner out | [`scripts/smoke-guards.mjs`](scripts/smoke-guards.mjs) |
| Unit tests, 194 | `node:test`, no database: rate limits, check-in and login guards, eligibility claims, state guards, seat counting, auth, startup settings, the gateway, the realtime client, poll timing and UI state | `npm test` |
| Source size | 11,094 lines of JS and MJS plus 2,104 of tests, 740 lines of SQL | repo |

**Methodology.** The unit tests use Node's built-in `node:test` and need nothing running. The
verification scripts are hand-rolled Node files that print check marks and exit non-zero on failure,
and most of them need a running server, the realtime gateway, and a seeded Postgres.
[CI](.github/workflows/ci.yml) runs all of it on every push and pull request to `main`: unit tests,
a production build, migrations twice (the second must be a no-op), the seed, and `db:verify`. It
then starts `next start` and the gateway in production mode, with tickets required, and runs
`realtime:verify` and every smoke script. Last, it checks that each server refuses to start
without its required settings. There are still no browser
or component tests; the UI was checked by hand.

**Not measured, and therefore not claimed:** latency. An earlier version of this README claimed
"sub-100ms" ballot delivery. That number was never measured, and its only source was a description
of the managed realtime service that this rewrite removed. There is no timing instrumentation
anywhere in this repository.

**Not measured:** concurrency. "60 to 80 concurrent voters" describes the room the predecessor was
designed for. This code has never been load tested. Load testing is phase 8 in the
[status table](#status), which is not started.

**Not audited.** The predecessor had a security review, and most of its fixes were carried forward
(the source marks them with the original finding numbers, such as `F1`, `F2`, `F9`, `F17`). This
rewrite has never been audited. That is also phase 8.

**Not deployed.** There is no hosted instance of this repository and no URL to visit.

## Running it

Requires Node 20.9 or newer (22 LTS or newer recommended) and PostgreSQL 16. Next.js 16 will not run
on anything older, and the `db:*` and `realtime` scripts load `.env.local` with `node --env-file`,
which Node 18 does not have. Docker is the easy way to get Postgres.

**1. Start Postgres.**

```bash
docker compose up -d
```

Note what this is: [`docker-compose.yml`](docker-compose.yml) contains one service, `postgres:16`,
bound to 127.0.0.1 only. It is not a deployment. The full self-host stack (app, gateway, TLS
terminator, object storage) is phase 8 and does not exist yet.

**2. Configure the environment.** Copy [`.env.example`](.env.example) to `.env.local`. Its values
match the Docker database.

```bash
cp .env.example .env.local
```

The two connection strings are the isolation model described above and are not interchangeable.
`DATABASE_URL` is the owner, used only by migrations, the seed, and `db:verify`. `APP_DATABASE_URL`
is the least-privilege `app` role, used by the web server and the gateway so that RLS applies.

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
still load and poll, but updates arrive late.

```bash
npm run dev        # terminal 1, Next.js on :3000
npm run realtime   # terminal 2, WebSocket gateway on :3001
```

`npm run realtime` runs the gateway as it would in production. It requires a signed ticket to
subscribe and accepts sockets only from `REALTIME_ALLOWED_ORIGINS`, which `.env.example` sets to
`http://localhost:3000`. Open the app at that address, not `127.0.0.1:3000`, or the live updates
will not connect. `npm run dev:realtime` runs it with `NODE_ENV=development` instead, where tickets
are optional and the settings have development defaults.

- Voter ballot: `http://localhost:3000/demo/spring-2026`, room PIN `197526`
- Host dashboard: `http://localhost:3000/admin`, sign in as `demo@example.com` / `demodemo123`
- Gateway health: `http://localhost:3001/health` returns
  `{"ok":true,"live":true,"rooms":N,"connections":N}`, or HTTP 503 with `"ok":false` while its
  Postgres LISTEN connection is down

**A successful run looks like this:** the gateway logs `LISTEN election_events` and then
`gateway on :3001`. The voter page shows a join screen with the demo organization's name and blue
accent. After joining you see a holding screen. Launch a position from the dashboard and the voter
tab flips to a ballot with a live countdown, with no refresh.

**5. Tests.**

```bash
npm test                   # 194 unit tests, nothing needs to be running
```

The verification scripts need step 4 running first.

```bash
npm run realtime:verify    # 16 checks, the gateway against real Postgres
npm run smoke:backend      # 14 checks
npm run smoke:auth         #  9 checks
npm run smoke:builder      #  8 checks
npm run smoke:eligibility  # 10 checks
npm run smoke:realtime     # 15 checks, tickets and the full path through a real API route
npm run smoke:guards       # 32 checks. Run it last: it locks the demo account for 15 minutes
                           # in any browser that has not logged in to it before
```

```bash
npm run build     # production build
npm start         # serve the production build
```

`npm start` refuses to start unless `.env.local` has `APP_DATABASE_URL` and a `REALTIME_SECRET` of
32 or more characters. The `REALTIME_SECRET` in `.env.example` is for your own machine. Generate a
new one for any real deploy with `openssl rand -hex 32`, and give the gateway the same value.

There is no lint script. Next.js 16 removed `next lint`, and `next build` no longer lints.

**Production settings.** `npm start`, and the gateway whenever `NODE_ENV` is not `development`,
refuse to start without these:

| Variable | Used by | Why |
| --- | --- | --- |
| `APP_DATABASE_URL` | app, gateway | The `app` role. A superuser, `BYPASSRLS`, or owner role is refused. |
| `REALTIME_SECRET` | app, gateway | 32 or more characters, the same in both. Signs subscribe tickets and check-in tags. |
| `REALTIME_ALLOWED_ORIGINS` | gateway | The site's origin, for example `https://vote.example.org`. Tickets are always required in production. |
| `APP_DB_PASSWORD` | `db:migrate` | Only needed when running migrations. |

Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app that append to
`X-Forwarded-For`. Without it the app ignores that header (a client can set it) and per-IP rate
limits are off. [`.env.example`](.env.example) lists the rest.

## Project layout

```
app/
├── [org]/[election]/page.js   Canonical voter route, renders VoterApp
├── page.js                    Landing page
├── admin/page.js              Auth, org creation, election builder, eligibility
│                              config, live presenter console, results
├── _lib/poll.js               Pure poll logic shared by both UIs: server clock
│                              offset, poll phase, which screen to show, chart colors
└── api/                       18 routes
    ├── auth/                  signup, login, logout, me, verify
    ├── state/route.js         launch, lock, finalize, clear_restart,
    │                          reset_position, reset_all_results
    ├── vote/route.js          POST casts a ballot, GET returns counts (host only)
    ├── checkin/route.js       POST joins, GET/PATCH/DELETE are host tools
    ├── realtime/ticket        Signed subscribe tickets for the gateway
    ├── elections, positions, candidates, orgs, roster, results, election
    └── seed/route.js          Retired, returns 410 to everyone

components/VoterApp.js         Join, ballot, countdown, WebSocket subscription,
                               reconnect banner, per-election localStorage

lib/
├── db.js                      pg pool, withOrg() transaction scoping, the RLS role check
├── auth.js                    scrypt hashing, DB-backed sessions, RBAC,
│                              authorizeElection() used by every admin route
├── eligibility.js             The six providers and list-entry claims
├── voter-identity.js          One-way voter keys and ballot references
├── state-guards.js            Which state changes are allowed from which state
├── realtime.js                emit(): pg_notify on the transaction client; tickets
├── realtime-client.js         Browser WebSocket with heartbeat, backoff, polling fallback
├── checkin-guard.js           Wrong PINs and codes: per-device and per-IP limits, slowdown
├── login-guard.js             Wrong passwords, and the known-device cookie
├── results.js                 Who wins a race with one or more seats
├── startup-check.js           A production server without its settings exits
├── api-helpers.js             resolveElectionOrg(), isUuid(), clampDuration()
├── fingerprint.js             Random per-browser device id
├── rate-limit.js              In-memory counters, per process
└── candidates-sort.js         Sort by last name for ballot display

db/
├── migrations/0001_init.sql   Tables, privileges, RLS on six tenant tables
├── migrations/0002_helpers.sql  election_org(), the narrow SECURITY DEFINER lookup
├── migrations/0003_auth.sql   user_sessions, email verification token
├── migrations/0004_eligibility.sql  claimed_by_device, binds an entry to one device
├── migrations/0005_ballot_secrecy.sql  ballots_cast, cast_ballot(), RLS on audit_log
├── migrations/0006_unique_ballot_names.sql  one name per race, one title per election
├── migrations/0007_vote_tallies.sql  per-candidate counters replace one row per vote
├── migrations/0008_voter_lookup_indexes.sql  indexes for the per-voter lookups
├── migrate.mjs, app-role.mjs  Runner. Creates the `app` role, applies in order
├── seed.mjs                   Dev fixtures only. No real organization data
├── verify-rls.mjs             The isolation proof
└── verify-upgrade.mjs         Migrates committed-format data in a scratch database

services/realtime/
├── server.mjs                 Startup and the RLS role check
├── config.mjs                 Settings; only NODE_ENV=development is development
├── gateway.mjs                Rooms, limits, tickets, the LISTEN connection
└── verify-realtime.mjs        End-to-end gateway checks

lib/tests, db/tests, services/realtime/test, app/_lib/*.test.mjs   Unit tests
scripts/                       6 HTTP smoke scripts (88 checks), the `next start` settings check
instrumentation.js             The same settings check for any other server entry point
.github/workflows/ci.yml       Runs everything above against a Postgres service container
docker-compose.yml             Postgres only. Not a deployment
```

## Status

The rewrite is on `main`, the default branch. It was planned in nine phases:

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Foundation: Docker Postgres, migration runner, `pg` data layer | Done |
| 1 | Multi-tenant schema, RLS, all single-organization hardcoding removed | Done |
| 2 | Self-hosted auth, organizations, per-org RBAC | Done |
| 3 | Realtime gateway replacing the managed broadcast service | Done |
| 4 | Election builder and canonical `/<org>/<election>` routing | Done |
| 5 | Pluggable eligibility providers | Done except `sso_oidc` |
| 6 | Billing and entitlements | **Not started** |
| 7 | Marketing site, brand, sign-up funnel | **Not started** |
| 8 | Hardening, load test, security audit, backups, monitoring | **Not started** |
| 9 | Business and legal | **Not started** |

Known gaps, in the order I would fix them:

- **There is no entitlement engine.** What exists is two empty tables (`plans`, `subscriptions`)
  and four plan rows the dev seed inserts. **Zero code reads or enforces a limit anywhere.** Nothing
  is gated. That is phase 6, and it is not started.
- **The rewrite has never been security audited** or load tested.
- **SMTP is not wired**, so email verification and magic links cannot reach anyone, and email-mode
  voters prove eligibility by knowing a listed address.
- **`sso_oidc` is an explicit stub**, and it is the feature a college deployment would need most.
- **`audit_log` exists and is under RLS, but nothing writes to it yet.**
- **`docker-compose.yml` is a database, not a stack.** Self-hosting the app today means running
  `next start` and `services/realtime/server.mjs` yourself and putting TLS in front of both.
- **Rate limiting is still per process**, which is the same limitation the predecessor had and gets
  worse, not better, on a multi-instance deployment.
- **No browser tests.** CI covers the API, the database, and the gateway, not the pages.

**Prior version.** The single-tenant application this replaces lives in a separate repository. It is
the one that ran a real University of Georgia student organization's officer election in spring
2026. It is also the one whose schema allows exactly one election to exist.

## License

MIT. See [LICENSE](LICENSE).

---

Jalen Edusei, [jalenedusei.com](https://www.jalenedusei.com),
[github.com/jke48222](https://github.com/jke48222)
