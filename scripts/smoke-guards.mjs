#!/usr/bin/env node
/**
 * Smoke test for the guards on check-in, login, results and the roster,
 * against a running server.
 *
 *   npm run dev · node scripts/smoke-guards.mjs
 *
 * Checks that:
 *   - 120 wrong room PINs from different devices slow wrong answers down but
 *     never block the right PIN, and the host sees the guessing and can clear it;
 *   - one device that keeps guessing is refused (429);
 *   - a new room PIN must be 6 to 8 digits, and the host can rotate it while
 *     a poll is live;
 *   - a tab still showing a locked race cannot finalize or restart the runoff
 *     another tab started (409 stale_state);
 *   - max_winners must be a whole number, and a two-seat race with a 3/2/1
 *     vote elects the top two;
 *   - the voter list cannot change while a poll is live, and a listed voter
 *     still gets one ballot;
 *   - wrong passwords from strangers cannot lock the account owner out of a
 *     browser that has logged in before.
 *
 * Run it after the other smoke tests: the last check locks demo@example.com
 * for logins without the known-device cookie for 15 minutes.
 */
import { randomBytes } from "node:crypto";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "demodemo123";

let failures = 0;
let cookie = "";
const ok = (c, m) => (c ? console.log(`  ✓ ${m}`) : (console.log(`  ✗ ${m}`), failures++));
const device = () => randomBytes(32).toString("hex");

async function api(path, { method = "GET", body, auth = false, headers: extra = {} } = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (auth && cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie");
  if (auth && sc && sc.includes("ev_session=")) cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
const state = (b) => api("/api/state", { method: "POST", auth: true, body: b });
const checkin = (b) => api("/api/checkin", { method: "POST", body: b });

async function checkinGuessing(E, pin) {
  console.log("check-in guessing");
  let lastWrongMs = 0;
  for (let i = 0; i < 120; i++) {
    const t0 = Date.now();
    await checkin({ election_id: E, display_name: `Guess ${i}`, device_hash: device(), pin: "000000" });
    lastWrongMs = Date.now() - t0;
  }
  ok(lastWrongMs >= 1400, `wrong PINs are answered slowly once guessing starts (${lastWrongMs} ms)`);
  const voters = [];
  for (let i = 0; i < 6; i++) {
    const d = device();
    const t0 = Date.now();
    const r = await checkin({ election_id: E, display_name: `Voter ${i}`, device_hash: d, pin });
    const ms = Date.now() - t0;
    if (i === 0) ok(r.status === 200 && ms < 1400, `the right PIN is admitted at once after 120 wrong ones (${r.status}, ${ms} ms)`);
    else if (r.status !== 200) ok(false, `voter ${i} check-in → ${r.status}`);
    voters.push(d);
  }
  const list = await api(`/api/checkin?election_id=${E}`, { auth: true });
  const f = list.json?.failures;
  ok(f?.slowed === true && f.recent >= 100, `the host's check-in list shows the guessing (${f?.recent} wrong)`);
  const reset = await api("/api/checkin", { method: "PATCH", auth: true, body: { election_id: E, reset_failures: true } });
  ok(reset.status === 200 && reset.json?.failures?.slowed === false, "the host can clear the count");
  const same = device();
  let last;
  for (let i = 0; i < 11; i++) {
    last = await checkin({ election_id: E, display_name: "Guesser", device_hash: same, pin: "111111" });
  }
  ok(last.status === 429, `one device that keeps guessing is refused (${last.status})`);
  return voters;
}

async function seatsAndStaleTabs(E, P, cands, voters) {
  console.log("stale tabs and multi-seat results");
  ok((await state({ action: "launch", election_id: E, position_id: P, duration: 120 })).status === 200, "launch");
  const rotate = await api("/api/elections", { method: "PATCH", auth: true, body: { election_id: E, pin: "864209" } });
  ok(rotate.status === 200, `the room PIN can be changed while a poll is live (${rotate.status})`);
  const title = await api("/api/elections", { method: "PATCH", auth: true, body: { election_id: E, title: "Renamed" } });
  ok(title.status === 409, `other settings still wait for the poll (${title.status})`);
  const plan = ["Ann A", "Ann A", "Ann A", "Ben B", "Ben B", "Cat C"];
  const vote = async () => {
    for (let i = 0; i < plan.length; i++) {
      const v = await api("/api/vote", {
        method: "POST",
        body: { election_id: E, position_id: P, candidate_id: cands[plan[i]], device_hash: voters[i] },
      });
      if (v.status !== 200) ok(false, `vote ${i} → ${v.status} ${JSON.stringify(v.json)}`);
    }
  };
  await vote();
  ok((await state({ action: "lock", election_id: E, position_id: P })).status === 200, "lock");
  ok((await state({ action: "clear_restart", election_id: E, position_id: P, duration: 60 })).status === 200, "tab B clears and restarts the race");
  const fin = await state({ action: "finalize", election_id: E, position_id: P });
  ok(fin.status === 409 && fin.json?.code === "stale_state", `tab A's finalize of the runoff is refused (${fin.status} ${fin.json?.code})`);
  const clr = await state({ action: "clear_restart", election_id: E, position_id: P });
  ok(clr.status === 409 && clr.json?.code === "stale_state", `tab A's clear and restart is refused (${clr.status} ${clr.json?.code})`);
  await vote();
  ok((await state({ action: "finalize", election_id: E })).status === 200, "finalize");
  const res = await api(`/api/results?election_id=${E}&position_id=${P}`, { auth: true });
  const w = res.json?.winner;
  ok(
    JSON.stringify(w?.names) === JSON.stringify(["Ann A", "Ben B"]) && w?.is_tie === false,
    `two seats with a 3/2/1 vote go to Ann and Ben (${JSON.stringify(w?.names)})`
  );
}

async function rosterDuringPoll(rnd) {
  console.log("voter list during a poll");
  const r = await api("/api/elections", {
    method: "POST",
    auth: true,
    body: { org_slug: "demo", title: "Guards Roster", slug: `guards-roster-${rnd}`, eligibility_mode: "roster_csv" },
  });
  const R = r.json?.election?.id;
  ok(r.status === 200 && R, "create a roster election");
  const rp = await api("/api/positions", { method: "POST", auth: true, body: { election_id: R, title: "Chair" } });
  const RP = rp.json?.position?.id;
  const rc = await api("/api/candidates", { method: "POST", auth: true, body: { election_id: R, position_id: RP, name: "Zed" } });
  const add = await api("/api/roster", { method: "POST", auth: true, body: { election_id: R, text: "Ann Voter\nBen Voter" } });
  ok(add.status === 200, "names can be added before the poll");
  const ann = device();
  await checkin({ election_id: R, display_name: "Ann Voter", device_hash: ann });
  await state({ action: "launch", election_id: R, position_id: RP, duration: 120 });
  const v1 = await api("/api/vote", { method: "POST", body: { election_id: R, position_id: RP, candidate_id: rc.json?.id, device_hash: ann } });
  ok(v1.status === 200 && !v1.json?.duplicate, "Ann votes");
  const del = await api("/api/roster", { method: "DELETE", auth: true, body: { election_id: R, all: true } });
  ok(del.status === 409, `clearing the list during a poll is refused (${del.status})`);
  const addLive = await api("/api/roster", { method: "POST", auth: true, body: { election_id: R, text: "Cy Voter" } });
  ok(addLive.status === 409, `adding a name during a poll is refused (${addLive.status})`);
  const codes = await api("/api/roster", { method: "POST", auth: true, body: { election_id: R, generate_codes: 1 } });
  ok(codes.status === 200, "access codes can still be generated during a poll");
  const again = await api("/api/vote", { method: "POST", body: { election_id: R, position_id: RP, candidate_id: rc.json?.id, device_hash: ann } });
  ok(again.json?.code === "already_voted", `Ann cannot vote twice (${again.json?.code})`);
  const tally = await api(`/api/vote?election_id=${R}&position_id=${RP}`, { auth: true });
  ok(tally.json?.total === 1, `one vote is counted (${tally.json?.total})`);
  await state({ action: "finalize", election_id: R });
}

async function loginLockout(known) {
  console.log("login lockout");
  for (let i = 0; i < 12; i++) {
    await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: "wrong-password" } });
  }
  const stranger = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  ok(stranger.status === 429, `a browser without the known-device cookie is locked out (${stranger.status})`);
  const owner = await api("/api/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
    headers: { Cookie: known },
  });
  ok(owner.status === 200, `the owner's browser still logs in (${owner.status})`);
}

async function main() {
  const login = await api("/api/auth/login", { method: "POST", auth: true, body: { email: EMAIL, password: PASSWORD } });
  ok(login.status === 200, "admin login");
  const known = login.headers.getSetCookie().find((c) => c.startsWith("ev_known="))?.split(";")[0];
  ok(Boolean(known), "login sets the known-device cookie");

  const rnd = String(process.hrtime.bigint()).slice(-7);
  const short = await api("/api/elections", {
    method: "POST",
    auth: true,
    body: { org_slug: "demo", title: "Short PIN", slug: `guards-short-${rnd}`, eligibility_mode: "pin", pin: "1234" },
  });
  ok(short.status === 400, `a new 4-digit room PIN is refused (${short.status})`);
  const PIN = "197526";
  const create = await api("/api/elections", {
    method: "POST",
    auth: true,
    body: { org_slug: "demo", title: "Guards", slug: `guards-${rnd}`, eligibility_mode: "pin", pin: PIN },
  });
  ok(create.status === 200, "create an election with a 6-digit PIN");
  const E = create.json.election.id;

  const frac = await api("/api/positions", { method: "POST", auth: true, body: { election_id: E, title: "Frac", max_winners: 2.5 } });
  ok(frac.status === 400, `max_winners 2.5 is refused (${frac.status})`);
  const pos = await api("/api/positions", { method: "POST", auth: true, body: { election_id: E, title: "Board", max_winners: 2 } });
  ok(pos.status === 200 && pos.json?.position?.max_winners === 2, "a two-seat race");
  const P = pos.json.position.id;
  const patchFrac = await api("/api/positions", { method: "PATCH", auth: true, body: { election_id: E, id: P, max_winners: "1.5" } });
  ok(patchFrac.status === 400, `max_winners "1.5" is refused on edit (${patchFrac.status})`);
  const cands = {};
  for (const name of ["Ann A", "Ben B", "Cat C"]) {
    const c = await api("/api/candidates", { method: "POST", auth: true, body: { election_id: E, position_id: P, name } });
    cands[name] = c.json?.id;
  }
  ok(Object.values(cands).every(Boolean), "three candidates");

  const voters = await checkinGuessing(E, PIN);
  await seatsAndStaleTabs(E, P, cands, voters);
  await rosterDuringPoll(rnd);
  // Last: this locks cookieless logins to the demo account for 15 minutes.
  if (known) await loginLockout(known);

  console.log(failures === 0 ? "\nGUARDS SMOKE TEST PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
