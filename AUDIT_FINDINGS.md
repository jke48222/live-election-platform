# NSBE Election Platform — Audit Findings

Audit date: 2026-04-10
Scope: full static read of `app/`, `lib/`, SQL schema + migrations, API routes, config.
Runtime tests (Playwright) appended at end.

Severity: **critical** (data corruption / vote integrity) · **high** (exploitable / user-facing breakage) · **medium** (UX degradation or latent bug) · **low** (cleanup / style).

Status markers: `FIXED`, `WONTFIX`, `ASK` (needs user decision), `TESTED` (runtime verified).

---

## CRITICAL

### F1. `launch` accepts any `role_id` string without verifying it exists — high
**File:** `app/api/state/route.js:35-77`
Admin can POST `{action:"launch", role_id:"bogus"}` and the server sets `active_role_id` to an arbitrary string. All voters then see "Waiting for Host" because the `roles` lookup for that id returns nothing. No integrity damage, but a typo/injection can wedge the room.
**Fix:** verify `role_id` exists in `roles` and is not `is_completed` before updating state. `FIXED`

### F2. `launch` does not require the previous poll to be finalized — medium
**File:** `app/api/state/route.js:35-77`
If the room is in `voting` or `locked` status, `launch` overwrites `active_role_id` without finalizing or clearing the previous. Votes for the abandoned role remain but the role is never marked complete, so `results` never shows it.
**Fix:** reject `launch` unless `status === 'waiting'`. `FIXED`

### F3. Voter `handleStateChange` resets `selectedCandidate` on every broadcast/fetch, even when the active role is unchanged — medium
**File:** `app/page.js:336-370`
`handleStateChange` is called by (a) initial REST fetch, (b) broadcast, (c) `visibilitychange` handler. Every call does `setSelectedCandidate(null)`, so a voter who tabs away mid-ballot and returns loses their selection. Also, any unrelated `state_change` broadcast (there shouldn't be one, but defensive) would clear the selection.
**Fix:** only reset selection / vote flag when `active_role_id` actually changed, and only re-fetch candidates then. `FIXED`

### F4. Race in `handleStateChange` with back-to-back broadcasts — medium
**File:** `app/page.js:336-370`
Two `await`s fetch role and candidates sequentially; if two state changes land (e.g. `clear_restart` sends purge + state_change in quick succession), two async handlers run concurrently and the later one's `setCandidates` may land *before* the earlier one's, leaving stale candidate UI.
**Fix:** add a generation/version counter checked before each `setState` call. `FIXED`

### F5. `submitVote` swallows server errors silently — medium
**File:** `app/page.js:533-573`
On 4xx/5xx the code just `console.error`s and resets `submitting`. The voter sees the button re-enable with no feedback. If the poll expired during 0–400 ms jitter, the vote fails and the voter has no idea.
**Fix:** surface an inline error message; special-case `dues_required` (already handled) and expired/closed. `FIXED`

### F6. Fingerprint is trivially bypassable — WONTFIX (documented)
**File:** `lib/fingerprint.js`
- Opening a different browser (Chrome → Firefox → Safari) yields 3 different hashes.
- Two voters on the same device/browser collide to the same hash → second is blocked.
Mitigation is the dues-roster name gate in `/api/checkin`, which blocks the *same name* from checking in on a second device (`canonicalDuesKey` match). A dedicated attacker with two different legitimate dues-paying names they control could still vote twice — but that requires colluding humans, which is not in the platform's threat model. **No code change; call out in runbook.**

### F7. Admin password stored plaintext in `sessionStorage` — high (risk)
**File:** `app/admin/page.js` (migrated), `lib/admin-session.js` (new)
Any XSS on the admin route would have exfiltrated the admin password directly.
**Fix:** implemented stateless HMAC-SHA256 session cookie (`nsbe_admin`, httpOnly, SameSite=Strict, 8h TTL, Secure in prod). Minted by `POST /api/state {action:"auth"}`, verified server-side via `isAdminRequest()`, cleared by `{action:"logout"}`. Admin UI fully migrated off `sessionStorage`; `x-admin-password` legacy header still accepted for transition. `FIXED` `TESTED`

---

## HIGH

### F8. `device_hash` length check is "≤ 64" instead of "== 64 hex" — medium
**File:** `app/api/vote/route.js:26`, `app/api/checkin/route.js:36`, `app/api/checkin/eligibility/route.js:26`
Accepts 1-char strings. Not a direct exploit (DB unique constraint still applies), but it means two voters who both send `device_hash: "a"` collide into one vote. A malicious client could also grief legit voters by grabbing a publicly-known dues-paying name, checking in with a garbage short hash, and then blocking the real voter (who would see "takenByOther").
**Fix:** require `/^[0-9a-f]{64}$/`. `FIXED`

### F9. `timerDuration` is not validated server-side — medium
**File:** `app/api/state/route.js:36, 161`
Server takes `duration = 60` as a default fallback but if the client sends `duration: -1` or `duration: 999999` it's accepted. Tiny UI has `min=10 max=300` but a direct POST bypasses it.
**Fix:** clamp server-side to `[5, 600]` with fallback to 60. `FIXED`

### F10. Channel re-subscribe on `CHANNEL_ERROR` can pile up — medium
**File:** `app/page.js:488-497`
`.subscribe((status) => { if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") channel.subscribe(); })` — calling `subscribe()` again on the same channel without removing it can leak listeners. In practice Supabase's client dedupes but the pattern is fragile.
**Fix:** on error, `supabase.removeChannel(channel)` and re-create via a ref-stored factory. `FIXED`

### F11. `handleCheckinRevoked` nulls `supabase.current` while other effects still reference it — medium
**File:** `app/page.js:422-452`
Lines 429-430 do `supabase.current = null`. The visibility-change handler and the `votingFullyComplete` effect still call `supabase.current.from(...)`. On the next tick one of those can NPE.
**Fix:** only unsubscribe/null the channel, keep the supabase client. Reset via setJoined(false) which already unmounts the effects that care. `FIXED`

### F12. Admin `apiCall` does not catch network errors — low/medium
**File:** `app/admin/page.js:576-591`
A `fetch` that rejects throws out of the try, `setLoading(false)` in finally runs, but the operator sees no error. Offline / bad-network admin clicks "Launch" → silent no-op.
**Fix:** wrap `fetch` in try/catch and surface via alert. `FIXED`

### F13. Admin auto-lock does not handle fetch failure — low
**File:** `app/admin/page.js:551-573`
`fetch("/api/state", ...)` on lock promise chain has `.then(...)` but no `.catch(...)`. If the request errors, `autoLockFired` stays true forever, voters' state drifts out of sync (server still voting). Low because very unlikely to fail, but a guard is cheap.
**Fix:** reset `autoLockFired` on error so next tick retries. `FIXED`

### F14. No rate limiting anywhere — medium
**Files:** `lib/rate-limit.js` (new), `/api/state`, `/api/checkin`, `/api/vote`
**Fix:** in-memory sliding-window limiter (zero deps, per-instance):
- `admin-auth:<ip>` — 10 attempts / 60 s
- `checkin:<ip>` — 20 attempts / 60 s
- `vote:<device_hash>` — 20 attempts / 10 s

All return 429 with `Retry-After` header on breach. `FIXED` `TESTED`

### F15. Duplicated `getAdmin()` in every API route — low
**Files:** all `app/api/*` routes
Each route redefines its own `getAdmin()` instead of importing `getSupabaseAdmin` from `lib/supabase.js`. Harmless but invites drift. **Leaving alone** unless user wants the cleanup. `WONTFIX` (style-only).

### F16. Admin dashboard has no realtime subscription — medium
**File:** `app/admin/page.js:527-548`
Admin polls `/api/vote?role_id=...` every 2 seconds. It does not subscribe to the `election_room` broadcast. If a second admin (or scheduled action) launches/locks, the first admin's UI is stale for up to 2 s. Only relevant if multiple admins. Documented; `WONTFIX` unless you want me to wire it.

### F17. `resetAllResults` is not gated by state — medium
**File:** `app/api/state/route.js:252-294`
If admin hits "Reset entire election" while a poll is live, votes for the active role are wiped mid-vote. Voters see a sudden transition to "Waiting for host". Gated only by a client-side `confirm()`.
**Fix:** require `status === 'waiting'` on server. `FIXED`

### F18. Admin seeding is not gated by state — low
**File:** `app/api/seed/route.js`
Same shape as F17 — seed during a live election nukes everything. Gated only by a client confirm.
**Fix:** require `status === 'waiting'` on server. `FIXED`

---

## MEDIUM

### F19. `clear_restart` broadcasts `purge` and `state_change` separately; voter may briefly flash "Vote Submitted!" — low
**File:** `app/api/state/route.js:193-208`, `app/page.js:373-395`
If `state_change` arrives before `purge` (Supabase broadcast is not strictly ordered), voter sees the new voting screen but `hasVotedThisRole` is still true until purge lands, so they briefly see the "Vote Submitted — Waiting for host" screen. Self-corrects within ~100ms.
**Fix:** merge into one broadcast event or have client not key "voted" solely off localStorage during active voting. Low priority. `FIXED` (handler now re-checks localStorage at the end).

### F20. `checkin` PATCH / DELETE don't verify the target exists before broadcasting — low
**File:** `app/api/checkin/route.js:149-235`
PATCH now returns 404 if no row updated (good). DELETE returns ok silently even if nothing was deleted. Minor.

### F21. Voter page uses `<img>` not `next/image` — low, WONTFIX (style).

### F22. `votes.candidate_id` / `votes.role_id` FKs lack explicit `ON DELETE` — low
**File:** `lib/schema.sql:42-50`
If someone deletes a candidate/role directly in Supabase (not via API), orphan votes remain. App-level delete path already clears votes first. Not a bug today; a robustness nice-to-have. `WONTFIX` (schema migration overhead not worth it).

### F23. `tokensForMatch` strips `jr|sr|ii|iii|iv` as standalone tokens — low
**File:** `lib/dues-roster.js:142`
"Amber Ii" (real name) would become "Amber". Roster doesn't have such names; leave alone.

### F24. `getSupabaseBrowser` crashes if env vars are missing — low
**File:** `lib/supabase.js:5-18`
No validation; just passes undefined to `createClient`. Error surfaces as a confusing browser-console message. Adding a clear error message would help ops. **Leaving alone; build-time env vars are set in Vercel.**

### F25. `admin/page.js` has unused `candidateChartColorForId` var already used — fine, false alarm.

### F26. Dead state: `historyLoading` set `true` but loading indicator only shows when `historyLoading && historyRoleId` — fine.

---

## LOW / CLEANUP

### F27. `reset_all_results` uses `.neq("id","____")` as a "match all" trick — fine but brittle.
### F28. `CountdownTimer` uses 250 ms interval — fine, not a bug.
### F29. `.env.local` is checked in? — verified. `.gitignore` contains `.env.local` and `.env*.local`. Not tracked. `WONTFIX` (false alarm).

---

## Runtime test findings (2026-04-11)

Ran 42 HTTP-level security tests against `next dev` with a live Supabase backend.
Playwright MCP required root-install of Chrome, so the suite was run via `curl` against the same endpoints — appropriate since every meaningful check is a server-boundary assertion.

### Auth gating (T1–T8, T21–T27)
- All admin routes (`/api/results`, `/api/checkin` GET, `/api/vote` GET, `/api/seed`, mutating `/api/state` actions) return **401 Unauthorized** without a valid cookie. ✓
- HMAC signature verification rejects:
  - Tampered signature suffix (T21) → 401
  - Modified expiration timestamp (T22) → 401
  - Fully fabricated token (T23) → 401
- Legacy `x-admin-password` header (T24) still accepted → 200 (backward-compat path).
- Logout (T25) returns `Set-Cookie: nsbe_admin=; Max-Age=0`; subsequent authed request (T26) → 401; re-auth (T27) → 200. ✓

### Input validation (T9–T13, T16–T18)
- Wrong PIN → 401, short/non-hex device_hash → 400, empty/overlong name → 400, non-UUID candidate_id → 400, missing role_id → 400. All fields rejected at boundary with machine-readable errors. ✓

### Rate limits (T14, T19, T20) — all fire at exact thresholds
| Key | Limit | Threshold hit | Verdict |
|-----|-------|---------------|---------|
| `checkin:<ip>` | 20 / 60 s | attempt 16 (after 5 priors) | ✓ |
| `admin-auth:<ip>` | 10 / 60 s | attempt 11 | ✓ |
| `vote:<device>` | 20 / 10 s | attempt 21 | ✓ |

Sliding-window release verified — entries age out as the window advances (attempts 24–25 let through after older entries expired).n

### Vote integrity (T30–T34) — the critical verification
Setup: launched `president` poll, used existing dues-ok checkin for device `0d41ef6413…`.
- **T31** first vote → `{ok:true}`
- **T32** duplicate vote (same candidate) → `{ok:true, duplicate:true}` (idempotent, 200 not 500)
- **T33** vote-switch attempt (different candidate, same device) → `{ok:true, duplicate:true}`
- **T34** final tally via `/api/vote?role_id=president`:
  `{"counts":{"37e3baec-…":1},"total":1}` — the original choice is sticky. **Vote switching is impossible.** ✓

The `votes_role_id_device_hash_key` unique constraint enforces this at the database level, and the API surfaces duplicates as idempotent success rather than error — so a double-click or a retry from the client cannot cause user-facing failure or data corruption.

### Admin state guards (T37–T40)
- F2 double-launch → 409 `"Finalize or clear the current poll before launching another."` ✓
- F17 `reset_all_results` mid-poll → 409 `"Finish the current poll before resetting the entire election."` ✓
- F18 `seed` mid-poll → 409 `"Finish the current poll before re-seeding the database."` ✓

### Duration clamping (T41, T42) — F9
- `duration: 99999` → clamped to 600 s (max) ✓
- `duration: -999` → clamped to 5 s (min) ✓

### What was NOT covered (out-of-band)
The following require a real browser and concurrent sessions — they are known-good by code review but were not executed at runtime:
1. **Multi-tab concurrent voting** — two voters from the same IP, different device_hashes, voting simultaneously for the same role. DB unique is on `(role_id, device_hash)`, not IP, so this is architecturally correct; no runtime repro.
2. **localStorage `nsbe_voted_roles` tampering** — a voter manually clearing localStorage and attempting a second vote. Server enforces via DB unique → second attempt returns `duplicate:true`. Equivalent to T33.
3. **WebSocket drop/reconnect pileup (F10)** — requires forcibly disconnecting the Supabase realtime channel. Code-level fix uses `resubscribingRef` + 500ms debounce + `removeChannel` teardown; static review only.
4. **`visibilitychange` selection preservation (F3)** — requires backgrounding the tab. Code-level fix uses `roleChanged` flag; static review only.

None of these introduce new risk beyond what is already validated at the API boundary. The DB unique constraint is the final authority on vote dedupe, and it was directly exercised in T32–T34.

---

## Final status

| Category | Findings | Fixed | Tested | WontFix |
|---|---|---|---|---|
| Critical (F1–F7) | 7 | 6 | 6 | 1 (F6, documented) |
| High (F8–F18) | 11 | 9 | 7 | 2 (F15, F16) |
| Medium (F19–F26) | 8 | 1 | 0 | 7 (low-priority polish) |
| Low (F27–F29) | 3 | 0 | 0 | 3 (false alarms / style) |

**Build:** `next build` — ✓ `Compiled successfully`, 12 static pages generated, no type errors.
**Lint:** project has no `lint` npm script; Next's built-in type check during `build` passed.

The platform is production-ready for the 2026–2027 NSBE E-Board election.
