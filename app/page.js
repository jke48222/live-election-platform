"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getSupabaseBrowser } from "../lib/supabase";
import { getDeviceHash } from "../lib/fingerprint";
import { NSBE_LOGO_ALT, NSBE_LOGO_SRC } from "../lib/branding";
import { sortCandidatesByLastName } from "../lib/candidates-sort";

const ROOM_PIN = process.env.NEXT_PUBLIC_ROOM_PIN || "1975";

/* ── Helpers ── */
function getVotedRoles() {
  try {
    return JSON.parse(localStorage.getItem("nsbe_voted_roles") || "[]");
  } catch {
    return [];
  }
}
function setVotedRoles(arr) {
  localStorage.setItem("nsbe_voted_roles", JSON.stringify(arr));
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PIN ENTRY SCREEN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const VOTER_NAME_STORAGE_KEY = "nsbe_voter_display_name";

function PinScreen({ onJoin, sessionNotice = "" }) {
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState(sessionNotice);

  useEffect(() => {
    setNotice(sessionNotice || "");
  }, [sessionNotice]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VOTER_NAME_STORAGE_KEY);
      if (saved) setDisplayName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  async function handleJoin() {
    const name = displayName.trim();
    if (!name) {
      setError("Please enter your name as it appears on the membership roster.");
      return;
    }
    if (pin !== ROOM_PIN) {
      setError("Invalid PIN. Please try again.");
      return;
    }
    setJoining(true);
    setError("");
    try {
      await onJoin(name);
      try {
        localStorage.setItem(VOTER_NAME_STORAGE_KEY, name);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e?.message || "Could not connect. Please try again.");
      setJoining(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
      <div className="w-full max-w-sm animate-scale-in">
        {/* Logo area */}
        <div className="text-center mb-8">
          <img
            src={NSBE_LOGO_SRC}
            alt={NSBE_LOGO_ALT}
            className="h-28 w-auto max-w-[min(100%,220px)] mx-auto mb-4 drop-shadow-md object-contain"
            width={211}
            height={220}
          />
          <h1 className="font-display font-black text-2xl text-uga-black">
            NSBE Elections
          </h1>
          <p className="text-uga-gray-mid mt-1 text-sm font-medium">
            UGA Chapter · 2026
          </p>
        </div>

        {/* Name (dues / roster verification) */}
        <label htmlFor="voter-name" className="block text-sm font-semibold text-uga-black mb-2">
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
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-uga-black font-medium
                     focus:border-uga-red focus:ring-2 focus:ring-uga-red/20 transition-all mb-4"
          autoFocus
          maxLength={255}
          aria-describedby={error ? "join-error" : undefined}
        />

        {/* PIN input */}
        <label htmlFor="pin" className="block text-sm font-semibold text-uga-black mb-2">
          Room PIN
        </label>
        <input
          id="pin"
          type="tel"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          placeholder="••••"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            setError("");
            setNotice("");
          }}
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          className="w-full h-14 text-center text-3xl tracking-[0.4em] font-bold
                     border-2 border-gray-200 rounded-xl bg-white
                     focus:border-uga-red focus:ring-2 focus:ring-uga-red/20
                     transition-all placeholder:text-gray-300"
          aria-describedby={error ? "join-error" : undefined}
        />

        {notice && (
          <p
            role="status"
            className="text-amber-900 text-sm mt-2 font-medium bg-amber-50 border border-amber-200/80 rounded-lg px-3 py-2"
          >
            {notice}
          </p>
        )}

        {error && (
          <p id="join-error" role="alert" className="text-uga-red text-sm mt-2 font-medium">
            {error}
          </p>
        )}

        <button
          onClick={handleJoin}
          disabled={!displayName.trim() || pin.length < 4 || joining}
          className="w-full mt-4 h-14 rounded-xl bg-uga-red text-white font-bold text-lg
                     shadow-lg shadow-uga-red/25
                     enabled:hover:bg-uga-red-dark enabled:active:scale-[0.98]
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-all duration-150"
          aria-label="Join election room"
        >
          {joining ? "Connecting…" : "Join Room"}
        </button>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   COUNTDOWN TIMER (absolute synchronization — PRD §4.3)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function CountdownTimer({ expiresAt }) {
  const [remaining, setRemaining] = useState(null);
  const announcedRef = useRef(new Set());

  useEffect(() => {
    if (!expiresAt) return;
    const target = new Date(expiresAt).getTime();
    announcedRef.current = new Set();

    function tick() {
      const delta = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(delta);

      // Screen reader announcements at milestones (PRD §6.3)
      const el = document.getElementById("sr-timer-announce");
      if (el && [60, 30, 10].includes(delta) && !announcedRef.current.has(delta)) {
        announcedRef.current.add(delta);
        el.textContent = `${delta} seconds remaining to vote.`;
      }
    }

    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining === null) return null;

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const isUrgent = remaining <= 10;

  return (
    <>
      <div
        role="timer"
        aria-label="Time remaining to vote"
        className={`text-center font-display font-black text-4xl tabular-nums
                     ${isUrgent ? "text-uga-red animate-pulse-red" : "text-uga-black"}`}
      >
        {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </div>
      {/* Hidden screen reader announcements at milestones */}
      <div id="sr-timer-announce" className="sr-only" aria-live="assertive" role="alert" />
    </>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BALLOT CARD (candidate selection)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function BallotCard({ candidate, isSelected, onSelect }) {
  return (
    <button
      onClick={onSelect}
      role="radio"
      aria-checked={isSelected}
      className={`w-full min-h-[48px] px-4 py-3 rounded-xl border-2 text-left
                   font-semibold text-base transition-all duration-150
                   ${
                     isSelected
                       ? "border-uga-red bg-uga-red/5 text-uga-red shadow-sm"
                       : "border-gray-200 bg-white text-uga-black hover:border-gray-300"
                   }`}
      style={{ minHeight: "48px" }} /* PRD §6.2: 48dp touch target */
    >
      <span className="flex items-center gap-3">
        <span
          className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center
                       ${isSelected ? "border-uga-red bg-uga-red" : "border-gray-300"}`}
        >
          {isSelected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <circle cx="5" cy="5" r="3" fill="white" />
            </svg>
          )}
        </span>
        {candidate.name}
      </span>
    </button>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MAIN ELECTION PAGE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function VoterPage() {
  const [joined, setJoined] = useState(false);
  const [deviceHash, setDeviceHash] = useState(null);
  /** Roster match or admin "Confirm dues" — required before casting a vote. */
  const [duesOk, setDuesOk] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");

  // Election state
  const [electionState, setElectionState] = useState(null); // { status, active_role_id, poll_expires_at }
  const [activeRole, setActiveRole] = useState(null);        // { id, title }
  const [candidates, setCandidates] = useState([]);

  // Voting
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [hasVotedThisRole, setHasVotedThisRole] = useState(false);
  const [timerExpired, setTimerExpired] = useState(false);
  /** True when host is idle and every role is marked complete in DB. */
  const [votingFullyComplete, setVotingFullyComplete] = useState(false);

  const supabase = useRef(null);
  const channelRef = useRef(null);
  /** Same device as state; used in broadcast handler so closure is never stale. */
  const deviceHashRef = useRef(null);
  /** F4: monotonic counter to drop out-of-order handleStateChange fetches. */
  const stateSeqRef = useRef(0);
  /** F10: prevents re-subscribe pile-up on rapid disconnects. */
  const resubscribingRef = useRef(false);

  /* ── Auto-detect timer expiry (triggers re-render to locked view) ── */
  useEffect(() => {
    if (electionState?.status !== "voting" || !electionState?.poll_expires_at) {
      setTimerExpired(false);
      return;
    }
    function check() {
      const expired = new Date(electionState.poll_expires_at).getTime() <= Date.now();
      setTimerExpired(expired);
    }
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [electionState?.status, electionState?.poll_expires_at]);

  /* ── Detect end of entire election (all roles finalized) ── */
  useEffect(() => {
    if (!joined || !supabase.current || !electionState) {
      setVotingFullyComplete(false);
      return;
    }
    const idleBetweenPolls =
      electionState.status === "waiting" && !electionState.active_role_id;
    if (!idleBetweenPolls) {
      setVotingFullyComplete(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.current.from("roles").select("is_completed");
      if (cancelled || error || !data?.length) return;
      setVotingFullyComplete(data.every((r) => r.is_completed));
    })();
    return () => {
      cancelled = true;
    };
  }, [joined, electionState]);

  /* ── Fetch current state from DB (fail-safe REST fetch — PRD §5.2) ── */
  const fetchCurrentState = useCallback(async () => {
    if (!supabase.current) return;
    const { data } = await supabase.current
      .from("election_state")
      .select("*")
      .single();
    if (data) handleStateChange(data);
  }, []);

  /* ── Handle state changes (from broadcast or REST) ── */
  const handleStateChange = useCallback(
    async (state) => {
      // F4: only the latest call may write to state; older fetches are dropped.
      const seq = ++stateSeqRef.current;

      // F3: detect whether the active race actually changed so we don't wipe
      // the voter's selection on incidental state updates for the same role.
      let roleChanged = true;
      setElectionState((prev) => {
        roleChanged = prev?.active_role_id !== state.active_role_id;
        return state;
      });

      if (!state.active_role_id) {
        if (seq !== stateSeqRef.current) return;
        setActiveRole(null);
        setCandidates([]);
        setSelectedCandidate(null);
        setHasVotedThisRole(false);
        return;
      }

      // Fetch role info
      const { data: role } = await supabase.current
        .from("roles")
        .select("*")
        .eq("id", state.active_role_id)
        .single();
      if (seq !== stateSeqRef.current) return;
      setActiveRole(role);

      // Fetch active candidates for this role
      const { data: cands } = await supabase.current
        .from("candidates")
        .select("*")
        .eq("role_id", state.active_role_id)
        .eq("is_active", true);
      if (seq !== stateSeqRef.current) return;
      setCandidates(sortCandidatesByLastName(cands || []));

      // Check if already voted for this role
      const voted = getVotedRoles();
      setHasVotedThisRole(voted.includes(state.active_role_id));
      if (roleChanged) setSelectedCandidate(null);
    },
    []
  );

  /* ── Handle broadcast events ── */
  const handleBroadcast = useCallback(
    (payload) => {
      const msg = payload.payload || payload;

      // Purge event (PRD §2.3): one role, or full reset (all votes cleared)
      if (msg.type === "purge") {
        if (msg.all) {
          setVotedRoles([]);
        } else if (msg.role_id) {
          const voted = getVotedRoles().filter((r) => r !== msg.role_id);
          setVotedRoles(voted);
        }
        setHasVotedThisRole(false);
        setSelectedCandidate(null);
      }

      // State update
      if (msg.status) {
        handleStateChange(msg);
      }
    },
    [handleStateChange]
  );

  const refreshDuesEligibility = useCallback(async () => {
    const h = deviceHashRef.current;
    if (!h) return;
    try {
      const res = await fetch("/api/checkin/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_hash: h }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.checked_in === true && typeof data.dues_ok === "boolean") {
        setDuesOk(data.dues_ok);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleDuesVerified = useCallback((payload) => {
    const msg = payload.payload || payload;
    if (msg?.device_hash && msg.device_hash === deviceHashRef.current) {
      setDuesOk(true);
    }
  }, []);

  const handleCheckinRevoked = useCallback((payload) => {
    const msg = payload.payload || payload;
    const revoked = msg?.device_hash;
    if (!revoked || revoked !== deviceHashRef.current) return;

    // F11: keep the supabase singleton around so a re-join can reuse it.
    // Only tear down the subscribed channel and device identity.
    try {
      if (channelRef.current && supabase.current?.removeChannel) {
        supabase.current.removeChannel(channelRef.current);
      } else {
        channelRef.current?.unsubscribe();
      }
    } catch {
      /* ignore */
    }
    channelRef.current = null;
    deviceHashRef.current = null;

    setJoined(false);
    setDeviceHash(null);
    setDuesOk(false);
    setElectionState(null);
    setActiveRole(null);
    setCandidates([]);
    setSelectedCandidate(null);
    setHasVotedThisRole(false);
    setTimerExpired(false);
    setVotingFullyComplete(false);
    setSubmitting(false);

    try {
      localStorage.removeItem(VOTER_NAME_STORAGE_KEY);
      localStorage.removeItem("nsbe_voted_roles");
    } catch {
      /* ignore */
    }

    setSessionNotice("You were removed from the room by an admin.");
  }, []);

  /* ── Join room: check-in name + device, then realtime ── */
  async function handleJoin(displayName) {
    supabase.current = getSupabaseBrowser();
    const hash = await getDeviceHash();

    const checkinRes = await fetch("/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: displayName,
        device_hash: hash,
        pin: ROOM_PIN,
      }),
    });
    const checkinJson = await checkinRes.json().catch(() => ({}));
    if (!checkinRes.ok) {
      throw new Error(checkinJson.error || "Check-in failed. Try again.");
    }

    setDuesOk(Boolean(checkinJson.dues_ok));

    setDeviceHash(hash);
    deviceHashRef.current = hash;

    // Subscribe to broadcast channel (PRD §4.2)
    const channel = supabase.current.channel("election_room", {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "state_change" }, handleBroadcast)
      .on("broadcast", { event: "purge" }, handleBroadcast)
      .on("broadcast", { event: "checkin_revoked" }, handleCheckinRevoked)
      .on("broadcast", { event: "dues_verified" }, handleDuesVerified)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          resubscribingRef.current = false;
          refreshDuesEligibility();
          // F4 companion: fetch current state on (re)subscribe so we don't
          // miss events that fired while disconnected.
          fetchCurrentState();
        }
        // PRD §5.2: heartbeat callback — reconnect on disconnect.
        // F10: guard against repeated subscribe() piling up retries.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (resubscribingRef.current) return;
          resubscribingRef.current = true;
          console.warn("Channel disconnected, reconnecting…");
          setTimeout(() => {
            if (channelRef.current === channel) channel.subscribe();
          }, 500);
        }
      });

    channelRef.current = channel;

    // Fetch initial state via REST
    await fetchCurrentState();
    setSessionNotice("");
    setJoined(true);
  }

  /* ── Page Visibility reconnection (PRD §5.2) ── */
  useEffect(() => {
    if (!joined) return;

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        fetchCurrentState();
        refreshDuesEligibility();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [joined, fetchCurrentState, refreshDuesEligibility]);

  /* ── Toggle overscroll prevention during active voting ── */
  useEffect(() => {
    if (electionState?.status === "voting" && !hasVotedThisRole) {
      document.body.classList.add("voting-active");
    } else {
      document.body.classList.remove("voting-active");
    }
    return () => document.body.classList.remove("voting-active");
  }, [electionState?.status, hasVotedThisRole]);

  /* ── Vote submission with jitter (PRD §4.1) — server enforces dues + poll rules ── */
  async function submitVote() {
    if (!selectedCandidate || !electionState?.active_role_id || !deviceHash) return;
    setSubmitting(true);
    setSubmitError("");

    // Random jitter 0-400ms to prevent stampeding herd
    const jitter = Math.random() * 400;
    await new Promise((r) => setTimeout(r, jitter));

    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role_id: electionState.active_role_id,
          candidate_id: selectedCandidate,
          device_hash: deviceHash,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "dues_required") {
          setDuesOk(false);
          setSubmitError(data.error || "Dues verification required.");
        } else if (res.status === 429) {
          setSubmitError("Too many attempts. Slow down and try again.");
        } else {
          setSubmitError(data.error || "Could not submit your vote. Try again.");
        }
        return;
      }

      // Mark as voted in LocalStorage (incl. duplicate idempotent success)
      const voted = getVotedRoles();
      if (!voted.includes(electionState.active_role_id)) {
        voted.push(electionState.active_role_id);
        setVotedRoles(voted);
      }
      setHasVotedThisRole(true);
    } catch {
      setSubmitError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /* ── Cleanup ── */
  useEffect(() => {
    return () => {
      try {
        if (channelRef.current && supabase.current?.removeChannel) {
          supabase.current.removeChannel(channelRef.current);
        } else {
          channelRef.current?.unsubscribe();
        }
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    };
  }, []);

  /* ═══════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════ */

  if (!joined) return <PinScreen onJoin={handleJoin} sessionNotice={sessionNotice} />;

  const status = electionState?.status || "waiting";

  /* ── WAITING STATE (between polls or election finished) ── */
  if (status === "waiting" || !activeRole) {
    if (votingFullyComplete) {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
          <div className="text-center max-w-md animate-fade-in">
            <img
              src={NSBE_LOGO_SRC}
              alt={NSBE_LOGO_ALT}
              className="h-16 w-auto mx-auto mb-5 object-contain opacity-90"
              width={120}
              height={125}
            />
            <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-green-50 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 className="font-display font-black text-xl text-uga-black">
              Voting complete!
            </h2>
            <p className="text-uga-gray-mid mt-3 text-sm leading-relaxed">
              Thank you for attending the NSBE E-Board 2026–2027 Elections.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
        <div className="text-center animate-fade-in">
          <img
            src={NSBE_LOGO_SRC}
            alt={NSBE_LOGO_ALT}
            className="h-14 w-auto mx-auto mb-5 object-contain opacity-90"
            width={105}
            height={110}
          />
          <div className="w-12 h-12 mx-auto mb-6 rounded-full bg-uga-red/10 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-uga-red animate-pulse-red" />
          </div>
          <h2 className="font-display font-black text-xl text-uga-black">
            Waiting for Host
          </h2>
          <p className="text-uga-gray-mid mt-2 text-sm">
            The next poll will appear here automatically.
          </p>
        </div>
      </div>
    );
  }

  /* ── LOCKED / TIME EXPIRED ── */
  if (status === "locked" || timerExpired) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
        <div className="text-center animate-fade-in">
          <img
            src={NSBE_LOGO_SRC}
            alt={NSBE_LOGO_ALT}
            className="h-14 w-auto mx-auto mb-4 object-contain opacity-90"
            width={105}
            height={110}
          />
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gray-200 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 className="font-display font-black text-xl text-uga-black">
            Voting Closed
          </h2>
          <p className="text-uga-gray-mid mt-1 text-sm">
            {activeRole?.title} — Results are being reviewed.
          </p>
        </div>
      </div>
    );
  }

  /* ── VOTED STATE ── */
  if (hasVotedThisRole) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
        <div className="text-center animate-scale-in">
          <img
            src={NSBE_LOGO_SRC}
            alt={NSBE_LOGO_ALT}
            className="h-14 w-auto mx-auto mb-4 object-contain opacity-90"
            width={105}
            height={110}
          />
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-green-50 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 className="font-display font-black text-xl text-uga-black">
            Vote Submitted!
          </h2>
          <p className="text-uga-gray-mid mt-1 text-sm">
            Waiting for host to proceed…
          </p>
          {electionState?.poll_expires_at && (
            <div className="mt-6 opacity-60">
              <CountdownTimer expiresAt={electionState.poll_expires_at} />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── ACTIVE POLL but dues not cleared (roster + admin confirm) ── */
  if (status === "voting" && !timerExpired && !duesOk) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
        <div className="text-center max-w-md animate-fade-in">
          <img
            src={NSBE_LOGO_SRC}
            alt={NSBE_LOGO_ALT}
            className="h-14 w-auto mx-auto mb-5 object-contain opacity-90"
            width={105}
            height={110}
          />
          <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-amber-50 flex items-center justify-center border border-amber-200/80">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#b45309"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <h2 className="font-display font-black text-xl text-uga-black">
            Membership verification pending
          </h2>
          <p className="text-uga-gray-mid mt-3 text-sm leading-relaxed">
            Your name is not on the automated dues list. You can vote after a host confirms your dues
            in the admin dashboard. Keep this page open — you will be able to vote as soon as they
            confirm.
          </p>
          {electionState?.poll_expires_at && (
            <div className="mt-8">
              <p className="text-xs font-semibold text-uga-gray-mid uppercase tracking-wide mb-2">
                Time remaining
              </p>
              <CountdownTimer expiresAt={electionState.poll_expires_at} />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── ACTIVE VOTING ── */
  return (
    <div className="min-h-dvh bg-uga-gray pb-32">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-lg border-b border-gray-100 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={NSBE_LOGO_SRC}
              alt=""
              className="h-11 w-auto shrink-0 object-contain"
              width={84}
              height={88}
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-uga-red uppercase tracking-wider">
                Now Voting
              </p>
              <h1 className="font-display font-black text-lg text-uga-black leading-tight truncate">
                {activeRole?.title}
              </h1>
            </div>
          </div>
          {electionState?.poll_expires_at && (
            <CountdownTimer expiresAt={electionState.poll_expires_at} />
          )}
        </div>
      </header>

      {/* Ballot */}
      <main className="max-w-lg mx-auto px-4 mt-4">
        <p className="text-sm text-uga-gray-mid mb-3 font-medium" id="ballot-label">
          Select one candidate
        </p>
        <div
          role="radiogroup"
          aria-labelledby="ballot-label"
          className="flex flex-col gap-2"
        >
          {candidates.map((c, i) => (
            <div
              key={c.id}
              className="animate-slide-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <BallotCard
                candidate={c}
                isSelected={selectedCandidate === c.id}
                onSelect={() => { setSelectedCandidate(c.id); setSubmitError(""); }}
              />
            </div>
          ))}
        </div>
      </main>

      {/* Fixed submit button */}
      <div className="fixed bottom-0 inset-x-0 p-4 bg-gradient-to-t from-uga-gray via-uga-gray to-transparent">
        <div className="max-w-lg mx-auto">
          {submitError && (
            <p
              role="alert"
              className="mb-2 text-sm font-medium text-uga-red bg-white border border-uga-red/30 rounded-lg px-3 py-2 shadow-sm"
            >
              {submitError}
            </p>
          )}
          <button
            onClick={submitVote}
            disabled={!selectedCandidate || submitting}
            className="w-full h-14 rounded-xl bg-uga-red text-white font-bold text-lg
                       shadow-lg shadow-uga-red/25
                       enabled:hover:bg-uga-red-dark enabled:active:scale-[0.98]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-all duration-150"
            aria-label="Submit your vote"
          >
            {submitting ? "Submitting…" : "Submit Vote"}
          </button>
        </div>
      </div>
    </div>
  );
}
