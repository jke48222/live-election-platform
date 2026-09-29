"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getDeviceHash } from "../lib/fingerprint";
import { sortCandidatesByLastName } from "../lib/candidates-sort";
import { connectElection } from "../lib/realtime-client";
import {
  clockOffsetMs,
  pollPhase,
  formatClock,
  createLatestGate,
  allPositionsFinalized,
  voterScreen,
  voteJitterMs,
  joinErrorNeedsElectionRefresh,
} from "../app/_lib/poll";

/* ── Per-election localStorage helpers (namespaced so elections don't bleed) ──
   Every access is wrapped: storage can throw in private mode or when blocked. */
function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* Cache of the positions this device voted in. The server's list
   (/api/checkin/eligibility) wins whenever it is available. */
const votedKey = (electionId) => `ev_voted:${electionId}`;
const getVotedPositions = (electionId) => {
  const v = readJson(votedKey(electionId), []);
  return Array.isArray(v) ? v : [];
};
const setVotedPositions = (electionId, arr) => writeJson(votedKey(electionId), arr);

/* A checked-in session, so a reload or a discarded tab returns to the room
   without the PIN or code. The server still decides: the device must still
   be checked in. */
const sessionKey = (electionId) => `ev_session:${electionId}`;

const VOTER_NAME_STORAGE_KEY = "ev_voter_display_name";

/** Fallback for the one-way tag that check-in events carry in place of the
    device id; the server normally returns it. crypto.subtle needs https. */
async function deviceTagFor(electionId, deviceHash) {
  try {
    const data = new TextEncoder().encode(`${String(electionId).toLowerCase()}:${deviceHash}`);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   JOIN SCREEN (name + optional PIN)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function JoinScreen({ org, election, onJoin, sessionNotice = "" }) {
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState(sessionNotice);
  // A ref, not state: a second Enter in the same render must see it.
  const busyRef = useRef(false);

  const mode = election?.eligibility_mode;
  const needsPin = mode === "pin";
  const needsCode = mode === "access_code";
  const needsEmail = mode === "email_magic_link";
  const title = org?.name || "Live Election";
  const subtitle = election?.title || "";
  const accent = org?.branding?.primary_color || "#2563eb";

  useEffect(() => setNotice(sessionNotice || ""), [sessionNotice]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VOTER_NAME_STORAGE_KEY);
      if (saved) setDisplayName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const ready =
    displayName.trim() &&
    (!needsPin || pin.length >= 4) &&
    (!needsCode || code.trim()) &&
    (!needsEmail || email.includes("@"));

  async function handleJoin() {
    if (busyRef.current) return;
    const name = displayName.trim();
    if (!name) return setError("Please enter your name.");
    if (needsPin && pin.length < 4) return setError("Enter the room PIN to join.");
    if (needsCode && !code.trim()) return setError("Enter your access code.");
    if (needsEmail && !email.includes("@")) return setError("Enter the email on your invite.");
    busyRef.current = true;
    setJoining(true);
    setError("");
    try {
      await onJoin(name, { pin, code: code.trim(), email: email.trim() });
      try {
        localStorage.setItem(VOTER_NAME_STORAGE_KEY, name);
      } catch {
        /* ignore */
      }
    } catch (e) {
      busyRef.current = false;
      setError(e?.message || "Could not connect. Please try again.");
      setJoining(false);
    }
  }

  const onEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleJoin();
    }
  };

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-slate-50">
      <div className="w-full max-w-sm animate-scale-in">
        <div className="text-center mb-8">
          <div
            className="h-16 w-16 mx-auto mb-4 rounded-2xl flex items-center justify-center text-white font-display font-black text-2xl shadow-lg"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            {title.charAt(0).toUpperCase()}
          </div>
          <h1 className="font-display font-black text-2xl text-slate-900 [overflow-wrap:anywhere]">{title}</h1>
          {subtitle && (
            <p className="text-slate-600 mt-1 text-sm font-medium [overflow-wrap:anywhere]">{subtitle}</p>
          )}
        </div>

        <label htmlFor="voter-name" className="block text-sm font-semibold text-slate-900 mb-2">
          Your full name
        </label>
        <input
          id="voter-name"
          type="text"
          autoComplete="name"
          placeholder="First and last name"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setError("");
            setNotice("");
          }}
          onKeyDown={onEnter}
          className="w-full h-12 px-4 rounded-xl border-2 border-slate-200 bg-white text-base text-slate-900 font-medium
                     focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 transition-all mb-4"
          autoFocus
          maxLength={255}
        />

        {needsPin && (
          <>
            <label htmlFor="pin" className="block text-sm font-semibold text-slate-900 mb-2">
              Room PIN
            </label>
            <input
              id="pin"
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              placeholder="••••"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, "").slice(0, 8));
                setError("");
                setNotice("");
              }}
              onKeyDown={onEnter}
              className="w-full h-14 text-center text-3xl tracking-[0.4em] font-bold
                         border-2 border-slate-200 rounded-xl bg-white
                         focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10
                         transition-all placeholder:text-slate-300"
            />
          </>
        )}

        {needsCode && (
          <>
            <label htmlFor="code" className="block text-sm font-semibold text-slate-900 mb-2">
              Access code
            </label>
            <input
              id="code"
              type="text"
              autoComplete="one-time-code"
              placeholder="Code from your invite"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError("");
              }}
              onKeyDown={onEnter}
              className="w-full h-12 px-4 mb-1 rounded-xl border-2 border-slate-200 bg-white text-center text-xl tracking-[0.3em] font-bold uppercase
                         focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 transition-all"
            />
          </>
        )}

        {needsEmail && (
          <>
            <label htmlFor="email" className="block text-sm font-semibold text-slate-900 mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="The email on your invite"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError("");
              }}
              onKeyDown={onEnter}
              className="w-full h-12 px-4 mb-1 rounded-xl border-2 border-slate-200 bg-white text-base text-slate-900 font-medium
                         focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 transition-all"
            />
          </>
        )}

        {notice && (
          <p
            role="status"
            className="text-amber-900 text-sm mt-3 font-medium bg-amber-50 border border-amber-200/80 rounded-lg px-3 py-2"
          >
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-700 text-sm mt-2 font-medium">
            {error}
          </p>
        )}

        <button
          onClick={handleJoin}
          disabled={!ready || joining}
          className="w-full mt-4 h-14 rounded-xl text-white font-bold text-lg shadow-lg
                     enabled:active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                     transition-all duration-150"
          style={{ backgroundColor: accent }}
          aria-label="Join election room"
        >
          {joining ? "Connecting…" : "Join"}
        </button>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   COUNTDOWN TIMER (server clock: offsetMs corrects this device's clock)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/* muted: a quieter slate for a voter who has already voted. Both palettes
   keep at least 4.5:1 on slate-50, including the urgent red. */
function CountdownTimer({ expiresAt, offsetMs = 0, muted = false }) {
  const [remaining, setRemaining] = useState(null);
  const announcedRef = useRef(new Set());

  useEffect(() => {
    if (!expiresAt) return;
    announcedRef.current = new Set();
    function tick() {
      const { remainingSec } = pollPhase({ status: "voting", expiresAt, offsetMs, nowMs: Date.now() });
      const delta = remainingSec ?? 0;
      setRemaining(delta);
      const el = document.getElementById("sr-timer-announce");
      if (el && [60, 30, 10].includes(delta) && !announcedRef.current.has(delta)) {
        announcedRef.current.add(delta);
        el.textContent = `${delta} seconds remaining to vote.`;
      }
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt, offsetMs]);

  if (remaining === null) return null;
  const isUrgent = remaining <= 10;

  return (
    <>
      <div
        role="timer"
        aria-label="Time remaining to vote"
        className="shrink-0 text-center font-display font-black text-4xl tabular-nums"
        style={{ color: muted ? (isUrgent ? "#b91c1c" : "#475569") : isUrgent ? "#dc2626" : "#0f172a" }}
      >
        {formatClock(remaining)}
      </div>
      <div id="sr-timer-announce" className="sr-only" aria-live="assertive" />
    </>
  );
}

/* ── Ballot option: a native radio styled as a card, so arrow keys move
   between candidates and the group is a single Tab stop. ── */
function BallotCard({ candidate, isSelected, onSelect, accent }) {
  return (
    <label className="block cursor-pointer">
      <input
        type="radio"
        name="ballot"
        value={candidate.id}
        checked={isSelected}
        onChange={onSelect}
        className="peer sr-only"
      />
      <span
        className="flex items-center gap-3 w-full min-h-[48px] px-4 py-3 rounded-xl border-2 text-left font-semibold text-base
                   transition-all duration-150 peer-focus-visible:outline peer-focus-visible:outline-[3px]
                   peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-900"
        style={{
          borderColor: isSelected ? accent : "#e2e8f0",
          backgroundColor: isSelected ? `${accent}0d` : "#fff",
          color: isSelected ? accent : "#0f172a",
        }}
      >
        <span
          className="flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center"
          style={{ borderColor: isSelected ? accent : "#64748b", backgroundColor: isSelected ? accent : "transparent" }}
          aria-hidden
        >
          {isSelected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <circle cx="5" cy="5" r="3" fill="white" />
            </svg>
          )}
        </span>
        <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{candidate.name}</span>
      </span>
    </label>
  );
}

/* The banner sits in the page flow above the card, so it never covers it. */
function CenteredCard({ children, banner = null }) {
  return (
    <div className="min-h-dvh flex flex-col bg-slate-50">
      {banner}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="text-center max-w-md min-w-0 animate-fade-in">{children}</div>
      </div>
    </div>
  );
}

function ConnectionBanner() {
  return (
    <p
      role="status"
      className="bg-amber-100 text-amber-900 text-sm font-medium text-center px-4 py-2 border-b border-amber-200"
    >
      Reconnecting, updates may be delayed
    </p>
  );
}

/* The ballot's fixed bottom bar. It reports its height, so the page can pad
   for all of it, error message included, and no candidate stays under it. */
function BottomBar({ onHeight, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(Math.ceil(el.getBoundingClientRect().height));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);
  return (
    <div
      ref={ref}
      className="fixed bottom-0 inset-x-0 px-4 pt-4 bg-gradient-to-t from-slate-50 via-slate-50 to-transparent"
      style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <CenteredCard>
      <div
        className="w-10 h-10 mx-auto rounded-full border-2 border-slate-200 border-t-slate-900 animate-spin"
        role="status"
        aria-label="Loading"
      />
    </CenteredCard>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MAIN VOTER PAGE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function VoterApp({ orgSlug, electionSlug }) {
  const [org, setOrg] = useState(null);
  const [election, setElection] = useState(null); // { id, title, status, active_position_id, poll_expires_at, eligibility_mode }
  const [positions, setPositions] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);

  const [joined, setJoined] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [deviceHash, setDeviceHash] = useState(null);
  const [eligible, setEligible] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");

  const [activePosition, setActivePosition] = useState(null);
  const [candidates, setCandidates] = useState([]);

  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [hasVotedThisPosition, setHasVotedThisPosition] = useState(false);
  const [timerExpired, setTimerExpired] = useState(false);
  const [votingFullyComplete, setVotingFullyComplete] = useState(false);
  // Position id whose vote the server had already recorded for this device.
  const [duplicateVoteId, setDuplicateVoteId] = useState(null);
  // Shown as a banner once the socket has been live and then dropped.
  const [connectionLost, setConnectionLost] = useState(false);
  // Height of the ballot's fixed bottom bar, measured (128 px until then).
  const [barHeight, setBarHeight] = useState(128);

  const connRef = useRef(null);
  const deviceHashRef = useRef(null);
  const deviceTagRef = useRef(null);
  const ticketRef = useRef(null); // { value, at } realtime subscribe ticket
  const electionIdRef = useRef(null);
  const activeIdRef = useRef(null);
  const gateRef = useRef(null);
  if (!gateRef.current) gateRef.current = createLatestGate();
  /* position id -> performance.now() when this page saw the vote accepted.
     Covers the gap where a refresh was already in flight when the vote landed. */
  const localVotesRef = useRef(new Map());

  const accent = org?.branding?.primary_color || "#2563eb";

  /* ── Load election metadata + state from the API (no direct DB access) ── */
  const fetchElection = useCallback(async () => {
    const sentAt = Date.now();
    const res = await fetch(
      `/api/election?org=${encodeURIComponent(orgSlug)}&election=${encodeURIComponent(electionSlug)}`,
      { cache: "no-store" }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Election not found.");
    return { ...json, offsetMs: clockOffsetMs(json.server_now, sentAt, Date.now()) };
  }, [orgSlug, electionSlug]);

  /* ── This device's status on the server: checked in, verified, voted where ── */
  const fetchVoterStatus = useCallback(async (electionId, hash) => {
    if (!electionId || !hash) return null;
    try {
      const res = await fetch("/api/checkin/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ election_id: electionId, device_hash: hash }),
        cache: "no-store",
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  const applyState = useCallback(
    async (token, electionRow, positionRows, votedIds) => {
      setElection(electionRow);
      setPositions(positionRows);
      electionIdRef.current = electionRow.id;

      const idleComplete =
        (electionRow.status === "completed" ||
          (electionRow.status === "waiting" && !electionRow.active_position_id)) &&
        allPositionsFinalized(positionRows);
      setVotingFullyComplete(idleComplete);

      const activeId = electionRow.active_position_id || null;
      if (activeId !== activeIdRef.current) {
        // A new race: nothing chosen for the last one carries over.
        activeIdRef.current = activeId;
        setSelectedCandidate(null);
        setSubmitError("");
        setCandidates([]);
      }
      if (!activeId) {
        setActivePosition(null);
        setCandidates([]);
        setHasVotedThisPosition(false);
        return;
      }

      setActivePosition(positionRows.find((p) => p.id === activeId) || null);
      setHasVotedThisPosition(votedIds.includes(activeId));

      const cRes = await fetch(
        `/api/candidates?election_id=${electionRow.id}&position_id=${activeId}`,
        { cache: "no-store" }
      );
      const cJson = await cRes.json().catch(() => ({}));
      if (!gateRef.current.isLatest(token)) return;
      const list = sortCandidatesByLastName(cJson.candidates || []);
      setCandidates(list);
      // Drop a choice the host has since taken off the ballot.
      setSelectedCandidate((prev) => (prev && list.some((c) => c.id === prev) ? prev : null));
    },
    []
  );

  const leaveRoom = useCallback((notice) => {
    try {
      connRef.current?.close();
    } catch {
      /* ignore */
    }
    connRef.current = null;
    gateRef.current.invalidate();
    if (electionIdRef.current) removeKey(sessionKey(electionIdRef.current));
    deviceHashRef.current = null;
    deviceTagRef.current = null;
    ticketRef.current = null;
    activeIdRef.current = null;
    localVotesRef.current = new Map();
    setJoined(false);
    setDeviceHash(null);
    setEligible(false);
    setActivePosition(null);
    setCandidates([]);
    setSelectedCandidate(null);
    setHasVotedThisPosition(false);
    setTimerExpired(false);
    setVotingFullyComplete(false);
    setSubmitting(false);
    setDuplicateVoteId(null);
    setConnectionLost(false);
    removeKey(VOTER_NAME_STORAGE_KEY);
    if (notice) setSessionNotice(notice);
  }, []);

  /* Full refresh (REST fail-safe; also used on (re)connect to catch missed
     events). The token is taken before the requests go out, so a slow
     response can never overwrite the state from a newer one. */
  const refreshAll = useCallback(async () => {
    const token = gateRef.current.begin();
    const startedAt = performance.now();
    try {
      const hash = deviceHashRef.current;
      const [data, status] = await Promise.all([
        fetchElection(),
        hash ? fetchVoterStatus(electionIdRef.current, hash) : Promise.resolve(null),
      ]);
      if (!gateRef.current.isLatest(token)) return;

      if (hash && status && status.checked_in === false) {
        // Removed by the host while this device was offline or asleep. Keep
        // the fresh election so the join form asks for what the host now wants.
        leaveRoom("You were removed from the room by the host.");
        setOrg(data.org);
        setElection(data.election);
        setPositions(data.positions || []);
        setOffsetMs(data.offsetMs);
        return;
      }

      setOrg(data.org);
      setOffsetMs(data.offsetMs);
      const electionId = data.election.id;
      let voted;
      if (status?.device_tag) deviceTagRef.current = status.device_tag;
      if (status?.ticket) ticketRef.current = { value: status.ticket, at: Date.now() };
      if (status?.checked_in && typeof status.verified === "boolean") setEligible(status.verified);
      if (status && Array.isArray(status.voted_position_ids)) {
        // Server truth, plus any vote this page saw accepted after the request left.
        voted = new Set(status.voted_position_ids);
        for (const [pid, at] of localVotesRef.current) if (at >= startedAt) voted.add(pid);
        voted = [...voted];
        setVotedPositions(electionId, voted);
      } else {
        voted = getVotedPositions(electionId);
      }
      await applyState(token, data.election, data.positions || [], voted);
    } catch (e) {
      if (gateRef.current.isLatest(token)) setLoadError(e.message);
    }
  }, [fetchElection, fetchVoterStatus, applyState, leaveRoom]);

  /* Realtime handlers go through refs so the socket always calls the latest ones. */
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  const onRealtimeEvent = useCallback(
    (event, data) => {
      if (event === "state_change") {
        refreshAll();
      } else if (event === "purge") {
        const id = electionIdRef.current;
        if (data?.all) {
          setVotedPositions(id, []);
          localVotesRef.current = new Map();
        } else if (data?.position_id) {
          setVotedPositions(
            id,
            getVotedPositions(id).filter((p) => p !== data.position_id)
          );
          localVotesRef.current.delete(data.position_id);
        }
        setHasVotedThisPosition(false);
        setSelectedCandidate(null);
        refreshAll();
      } else if (event === "checkin_verified") {
        if (data?.device_tag && data.device_tag === deviceTagRef.current) setEligible(true);
      } else if (event === "checkin_revoked") {
        if (data?.all) {
          // The host changed the eligibility mode or cleared the list. Stay
          // only if the server still has this device checked in.
          fetchVoterStatus(electionIdRef.current, deviceHashRef.current).then((status) => {
            if (status && status.checked_in === false) {
              leaveRoom("The host changed how voters check in. Join again.");
              // Reload the election so the join form shows the new mode.
              fetchElection()
                .then((d) => {
                  setOrg(d.org);
                  setElection(d.election);
                  setPositions(d.positions || []);
                  setOffsetMs(d.offsetMs);
                })
                .catch(() => {});
            } else {
              refreshAll();
            }
          });
        } else if (data?.device_tag && data.device_tag === deviceTagRef.current) {
          leaveRoom("You were removed from the room by the host.");
        }
      } else if (event === "settings_changed") {
        refreshAll();
      }
    },
    [refreshAll, leaveRoom, fetchVoterStatus, fetchElection]
  );
  const onEventRef = useRef(onRealtimeEvent);
  onEventRef.current = onRealtimeEvent;

  /* A subscribe ticket: the one from the last check-in or status refresh
     while it is fresh (they last 5 minutes), else a new one. */
  const getTicket = useCallback(async () => {
    const t = ticketRef.current;
    if (t && Date.now() - t.at < 4 * 60_000) return t.value;
    const res = await fetch("/api/realtime/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ election_id: electionIdRef.current, device_hash: deviceHashRef.current }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ticket) throw new Error(data.error || "No realtime ticket");
    ticketRef.current = { value: data.ticket, at: Date.now() };
    return data.ticket;
  }, []);

  /** One socket per page: close any earlier one before opening another.
      The client refetches through onSync after each subscribe, when the tab
      becomes visible, and on a timer, so missed events are caught up. */
  const connectRealtime = useCallback(
    (electionId) => {
      try {
        connRef.current?.close();
      } catch {
        /* ignore */
      }
      let wasOpen = false;
      setConnectionLost(false);
      connRef.current = connectElection(electionId, {
        onEvent: (event, data) => onEventRef.current(event, data),
        onSync: () => refreshAllRef.current(),
        onStatus: (status) => {
          if (status === "open") {
            wasOpen = true;
            setConnectionLost(false);
          } else if (wasOpen) {
            setConnectionLost(true);
          }
        },
        getTicket,
      });
    },
    [getTicket]
  );

  /* ── Enter the room once the server has accepted this device ── */
  const enterRoom = useCallback(
    async (electionId, hash, verified, { deviceTag, ticket } = {}) => {
      setEligible(Boolean(verified));
      setDeviceHash(hash);
      deviceHashRef.current = hash;
      deviceTagRef.current = deviceTag || (await deviceTagFor(electionId, hash));
      ticketRef.current = ticket ? { value: ticket, at: Date.now() } : null;
      connectRealtime(electionId);
      await refreshAllRef.current();
      setSessionNotice("");
      setJoined(true);
    },
    [connectRealtime]
  );

  /* ── Initial load; then rejoin a saved session without the PIN or code ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchElection();
        if (cancelled) return;
        setOrg(data.org);
        setElection(data.election);
        setPositions(data.positions || []);
        setOffsetMs(data.offsetMs);
        electionIdRef.current = data.election.id;

        const saved = readJson(sessionKey(data.election.id), null);
        if (saved) {
          const hash = await getDeviceHash();
          const status = await fetchVoterStatus(data.election.id, hash);
          if (cancelled) return;
          if (status?.checked_in) {
            await enterRoom(data.election.id, hash, status.verified, {
              deviceTag: status.device_tag,
              ticket: status.ticket,
            });
          } else if (status) {
            removeKey(sessionKey(data.election.id));
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchElection, fetchVoterStatus, enterRoom]);

  /* ── Timer expiry, on the server's clock ── */
  useEffect(() => {
    if (election?.status !== "voting" || !election?.poll_expires_at) {
      setTimerExpired(false);
      return;
    }
    function check() {
      const { phase } = pollPhase({
        status: "voting",
        expiresAt: election.poll_expires_at,
        offsetMs,
        nowMs: Date.now(),
      });
      setTimerExpired(phase === "closed");
    }
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [election?.status, election?.poll_expires_at, offsetMs]);

  /* ── Keep the join form current ──
     Realtime starts only after check-in, so a voter who opens the link early
     would otherwise keep the fields of the mode the page loaded with. */
  const reloadElectionForJoin = useCallback(async () => {
    try {
      const d = await fetchElection();
      setOrg(d.org);
      setElection(d.election);
      setPositions(d.positions || []);
      setOffsetMs(d.offsetMs);
      electionIdRef.current = d.election.id;
      return d.election;
    } catch {
      return null;
    }
  }, [fetchElection]);

  const showingJoin = !joined && !restoring && !!election;
  useEffect(() => {
    if (!showingJoin) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") reloadElectionForJoin();
    };
    const id = setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [showingJoin, reloadElectionForJoin]);

  /* Bring the chosen candidate into view when an error appears, so the voter
     can see and check their choice before trying again. */
  useEffect(() => {
    if (!submitError || !selectedCandidate) return;
    const id = requestAnimationFrame(() => {
      document.getElementById(`ballot-${selectedCandidate}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [submitError, selectedCandidate]);

  /* ── Join: check-in, then connect realtime ── */
  async function handleJoin(displayName, { pin, code, email } = {}) {
    const hash = await getDeviceHash();
    const electionId = electionIdRef.current;
    if (!electionId) throw new Error("Election is still loading. Try again.");

    const res = await fetch("/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ election_id: electionId, display_name: displayName, device_hash: hash, pin, code, email }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      let message = json.error || "Check-in failed. Try again.";
      // The host may have changed how voters check in since this page
      // loaded. Reload the election so the form shows the fields it needs.
      if (joinErrorNeedsElectionRefresh(res.status, json.code)) {
        const before = election?.eligibility_mode;
        const fresh = await reloadElectionForJoin();
        if (fresh && fresh.eligibility_mode !== before) {
          message = "The host changed how voters check in. Fill in the new field and join again.";
        }
      }
      throw new Error(message);
    }

    writeJson(sessionKey(electionId), { displayName, at: Date.now() });
    await enterRoom(electionId, hash, json.verified, { deviceTag: json.device_tag, ticket: json.ticket });
  }

  /* ── Overscroll lock during active voting ── */
  useEffect(() => {
    if (election?.status === "voting" && !hasVotedThisPosition) {
      document.body.classList.add("voting-active");
    } else {
      document.body.classList.remove("voting-active");
    }
    return () => document.body.classList.remove("voting-active");
  }, [election?.status, hasVotedThisPosition]);

  /* ── Cleanup ── */
  useEffect(() => {
    return () => {
      try {
        connRef.current?.close();
      } catch {
        /* ignore */
      }
      connRef.current = null;
    };
  }, []);

  /* ── Vote submission (with jitter) ── */
  async function submitVote() {
    if (submitting || !selectedCandidate || !election?.active_position_id || !deviceHash) return;
    const positionId = election.active_position_id;
    setSubmitting(true);
    setSubmitError("");
    // Spread a room's submits a little, but never in the last 2 seconds.
    const { remainingSec } = pollPhase({
      status: election.status,
      expiresAt: election.poll_expires_at,
      offsetMs,
      nowMs: Date.now(),
    });
    const wait = voteJitterMs(remainingSec);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          election_id: election.id,
          position_id: positionId,
          candidate_id: selectedCandidate,
          device_hash: deviceHash,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "verification_required") {
          setEligible(false);
          setSubmitError(data.error || "Eligibility verification required.");
        } else if (data.code === "not_checked_in") {
          leaveRoom("Your session ended. Rejoin to vote.");
        } else if (res.status === 429) {
          setSubmitError("Too many attempts. Slow down and try again.");
        } else {
          setSubmitError(data.error || "Could not submit your vote. Try again.");
        }
        return;
      }
      if (data.duplicate || data.code === "already_voted") setDuplicateVoteId(positionId);
      localVotesRef.current.set(positionId, performance.now());
      const id = election.id;
      const voted = getVotedPositions(id);
      if (!voted.includes(positionId)) {
        voted.push(positionId);
        setVotedPositions(id, voted);
      }
      if (activeIdRef.current === positionId) setHasVotedThisPosition(true);
    } catch {
      setSubmitError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /* ═══════════ RENDER ═══════════ */

  if (loadError && !election) {
    return (
      <CenteredCard>
        <h2 className="font-display font-black text-xl text-slate-900">Election unavailable</h2>
        <p className="text-slate-600 mt-2 text-sm">{loadError}</p>
      </CenteredCard>
    );
  }
  if (!election || (restoring && !joined)) return <Spinner />;

  if (!joined) {
    return (
      <JoinScreen org={org} election={election} onJoin={handleJoin} sessionNotice={sessionNotice} />
    );
  }

  const status = election?.status || "waiting";
  const positionTitle = activePosition?.title || "";
  const banner = connectionLost ? <ConnectionBanner /> : null;
  const screen = voterScreen({
    status,
    hasActivePosition: !!activePosition,
    allDone: votingFullyComplete,
    eligible,
    eligibilityMode: election?.eligibility_mode,
    phase: timerExpired ? "closed" : "open",
    hasVoted: hasVotedThisPosition,
  });

  if (screen === "complete") {
    return (
      <CenteredCard banner={banner}>
        <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-green-50 flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Voting complete!</h2>
        <p className="text-slate-600 mt-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
          Thank you for voting in {election.title}.
        </p>
      </CenteredCard>
    );
  }

  if (screen === "waiting") {
    return (
      <CenteredCard banner={banner}>
        <div className="w-12 h-12 mx-auto mb-6 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1a` }}>
          <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Waiting for host</h2>
        <p className="text-slate-600 mt-2 text-sm">The next poll will appear here automatically.</p>
      </CenteredCard>
    );
  }

  if (screen === "closed") {
    return (
      <CenteredCard banner={banner}>
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-slate-200 flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Voting closed</h2>
        <p className="text-slate-600 mt-1 text-sm [overflow-wrap:anywhere]">
          {positionTitle ? `Voting for ${positionTitle} is closed. ` : ""}The host is reviewing the results.
        </p>
        {submitting && (
          <p role="status" className="mt-4 text-sm font-medium text-slate-900">
            Your vote is still being sent. Keep this page open.
          </p>
        )}
        {!submitting && submitError && (
          <p role="alert" className="mt-4 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg px-3 py-2 [overflow-wrap:anywhere]">
            Your vote was not recorded: {submitError}
          </p>
        )}
      </CenteredCard>
    );
  }

  if (screen === "voted") {
    return (
      <CenteredCard banner={banner}>
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-green-50 flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">
          {duplicateVoteId && duplicateVoteId === election?.active_position_id ? "Already voted" : "Vote submitted!"}
        </h2>
        {duplicateVoteId && duplicateVoteId === election?.active_position_id && (
          <p className="text-slate-600 mt-1 text-sm">This device already voted in this race.</p>
        )}
        {status === "voting" && !timerExpired ? (
          <p className="text-slate-600 mt-1 text-sm">Waiting for host to proceed…</p>
        ) : (
          <p className="text-slate-600 mt-1 text-sm [overflow-wrap:anywhere]">
            Your vote was recorded. {positionTitle ? `Voting for ${positionTitle} is closed.` : "Voting is closed."}
          </p>
        )}
        {status === "voting" && !timerExpired && election?.poll_expires_at && (
          <div className="mt-6">
            <CountdownTimer expiresAt={election.poll_expires_at} offsetMs={offsetMs} muted />
          </div>
        )}
      </CenteredCard>
    );
  }

  /* Checked in, but the host has not confirmed this voter yet */
  if (screen === "pending") {
    const live = status === "voting" && !!activePosition;
    return (
      <CenteredCard banner={banner}>
        <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-amber-50 flex items-center justify-center border border-amber-200/80">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">
          {live ? "Eligibility pending" : "Waiting for the host to confirm you can vote"}
        </h2>
        <p className="text-slate-600 mt-3 text-sm leading-relaxed">
          {live
            ? "Your eligibility hasn’t been confirmed yet. Keep this page open. You’ll be able to vote as soon as the host verifies you."
            : "You’re checked in, but your name wasn’t matched to the list. Keep this page open. The host needs to verify you before you can vote in the next poll."}
        </p>
        {live && election?.poll_expires_at && (
          <div className="mt-8">
            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Time remaining</p>
            <CountdownTimer expiresAt={election.poll_expires_at} offsetMs={offsetMs} />
          </div>
        )}
      </CenteredCard>
    );
  }

  /* ACTIVE VOTING */
  return (
    <div
      className="min-h-dvh bg-slate-50"
      style={{ paddingBottom: `calc(${barHeight + 8}px + env(safe-area-inset-bottom))` }}
    >
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-lg border-b border-slate-100">
        {banner}
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
              Now voting
            </p>
            <h1
              className="font-display font-black text-lg text-slate-900 leading-tight line-clamp-2 [overflow-wrap:anywhere]"
              title={positionTitle}
            >
              {positionTitle}
            </h1>
          </div>
          {election?.poll_expires_at && (
            <CountdownTimer expiresAt={election.poll_expires_at} offsetMs={offsetMs} />
          )}
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 mt-4">
        <fieldset>
          <legend className="text-sm text-slate-600 mb-3 font-medium [overflow-wrap:anywhere]">
            Select one candidate for <strong className="text-slate-900">{positionTitle}</strong>
          </legend>
          <div className="flex flex-col gap-2">
            {candidates.map((c, i) => (
              <div
                key={c.id}
                id={`ballot-${c.id}`}
                className="animate-slide-up"
                style={{ animationDelay: `${i * 60}ms`, scrollMarginBottom: `${barHeight + 8}px` }}
              >
                <BallotCard
                  candidate={c}
                  isSelected={selectedCandidate === c.id}
                  onSelect={() => {
                    setSelectedCandidate(c.id);
                    setSubmitError("");
                  }}
                  accent={accent}
                />
              </div>
            ))}
          </div>
        </fieldset>
      </main>

      <BottomBar onHeight={setBarHeight}>
        <div className="max-w-lg mx-auto">
          {submitError && (
            <p role="alert" className="mb-2 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg px-3 py-2 shadow-sm">
              {submitError}
            </p>
          )}
          <button
            onClick={submitVote}
            disabled={!selectedCandidate || submitting}
            className="w-full h-14 rounded-xl text-white font-bold text-lg shadow-lg
                       enabled:active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150"
            style={{ backgroundColor: accent }}
            aria-label="Submit your vote"
          >
            {submitting ? "Submitting…" : "Submit Vote"}
          </button>
        </div>
      </BottomBar>
    </div>
  );
}
