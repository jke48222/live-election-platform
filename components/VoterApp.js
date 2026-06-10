"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getDeviceHash } from "../lib/fingerprint";
import { sortCandidatesByLastName } from "../lib/candidates-sort";
import { connectElection } from "../lib/realtime-client";

/* ── Per-election localStorage helpers (namespaced so elections don't bleed) ── */
function votedKey(electionId) {
  return `ev_voted:${electionId}`;
}
function getVotedPositions(electionId) {
  try {
    return JSON.parse(localStorage.getItem(votedKey(electionId)) || "[]");
  } catch {
    return [];
  }
}
function setVotedPositions(electionId, arr) {
  localStorage.setItem(votedKey(electionId), JSON.stringify(arr));
}

const VOTER_NAME_STORAGE_KEY = "ev_voter_display_name";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   JOIN SCREEN (name + optional PIN)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function JoinScreen({ org, election, onJoin, sessionNotice = "" }) {
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState(sessionNotice);

  const needsPin = election?.eligibility_mode === "pin";
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

  async function handleJoin() {
    const name = displayName.trim();
    if (!name) {
      setError("Please enter your name.");
      return;
    }
    if (needsPin && pin.length < 4) {
      setError("Enter the room PIN to join.");
      return;
    }
    setJoining(true);
    setError("");
    try {
      await onJoin(name, needsPin ? pin : null);
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
          <h1 className="font-display font-black text-2xl text-slate-900">{title}</h1>
          {subtitle && <p className="text-slate-500 mt-1 text-sm font-medium">{subtitle}</p>}
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
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          className="w-full h-12 px-4 rounded-xl border-2 border-slate-200 bg-white text-slate-900 font-medium
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
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              className="w-full h-14 text-center text-3xl tracking-[0.4em] font-bold
                         border-2 border-slate-200 rounded-xl bg-white
                         focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10
                         transition-all placeholder:text-slate-300"
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
          <p role="alert" className="text-red-600 text-sm mt-2 font-medium">
            {error}
          </p>
        )}

        <button
          onClick={handleJoin}
          disabled={!displayName.trim() || (needsPin && pin.length < 4) || joining}
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
   COUNTDOWN TIMER (absolute synchronization)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function CountdownTimer({ expiresAt, accent = "#dc2626" }) {
  const [remaining, setRemaining] = useState(null);
  const announcedRef = useRef(new Set());

  useEffect(() => {
    if (!expiresAt) return;
    const target = new Date(expiresAt).getTime();
    announcedRef.current = new Set();
    function tick() {
      const delta = Math.max(0, Math.ceil((target - Date.now()) / 1000));
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
        className="text-center font-display font-black text-4xl tabular-nums"
        style={{ color: isUrgent ? "#dc2626" : "#0f172a" }}
      >
        {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
      </div>
      <div id="sr-timer-announce" className="sr-only" aria-live="assertive" role="alert" />
    </>
  );
}

/* ── Ballot card ── */
function BallotCard({ candidate, isSelected, onSelect, accent }) {
  return (
    <button
      onClick={onSelect}
      role="radio"
      aria-checked={isSelected}
      className="w-full min-h-[48px] px-4 py-3 rounded-xl border-2 text-left font-semibold text-base transition-all duration-150"
      style={{
        minHeight: "48px",
        borderColor: isSelected ? accent : "#e2e8f0",
        backgroundColor: isSelected ? `${accent}0d` : "#fff",
        color: isSelected ? accent : "#0f172a",
      }}
    >
      <span className="flex items-center gap-3">
        <span
          className="flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center"
          style={{ borderColor: isSelected ? accent : "#cbd5e1", backgroundColor: isSelected ? accent : "transparent" }}
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

function CenteredCard({ children }) {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-slate-50">
      <div className="text-center max-w-md animate-fade-in">{children}</div>
    </div>
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

  const [joined, setJoined] = useState(false);
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

  const connRef = useRef(null);
  const deviceHashRef = useRef(null);
  const electionIdRef = useRef(null);
  const stateSeqRef = useRef(0);

  const accent = org?.branding?.primary_color || "#2563eb";

  /* ── Load election metadata + state from the API (no direct DB access) ── */
  const fetchElection = useCallback(async () => {
    const res = await fetch(
      `/api/election?org=${encodeURIComponent(orgSlug)}&election=${encodeURIComponent(electionSlug)}`
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Election not found.");
    return json; // { org, election, positions }
  }, [orgSlug, electionSlug]);

  const applyState = useCallback(
    async (electionRow, positionRows) => {
      const seq = ++stateSeqRef.current;
      setElection(electionRow);
      setPositions(positionRows);
      electionIdRef.current = electionRow.id;

      const idleComplete =
        (electionRow.status === "completed" ||
          (electionRow.status === "waiting" && !electionRow.active_position_id)) &&
        positionRows.length > 0 &&
        positionRows.every((p) => p.is_completed);
      setVotingFullyComplete(idleComplete);

      const activeId = electionRow.active_position_id;
      if (!activeId) {
        setActivePosition(null);
        setCandidates([]);
        setSelectedCandidate(null);
        setHasVotedThisPosition(false);
        return;
      }

      const pos = positionRows.find((p) => p.id === activeId) || null;
      setActivePosition(pos);

      const cRes = await fetch(
        `/api/candidates?election_id=${electionRow.id}&position_id=${activeId}`
      );
      const cJson = await cRes.json().catch(() => ({}));
      if (seq !== stateSeqRef.current) return;
      setCandidates(sortCandidatesByLastName(cJson.candidates || []));

      const voted = getVotedPositions(electionRow.id);
      setHasVotedThisPosition(voted.includes(activeId));
    },
    []
  );

  /* Full refresh (REST fail-safe; also used on (re)connect to catch missed events). */
  const refreshAll = useCallback(async () => {
    try {
      const data = await fetchElection();
      setOrg(data.org);
      await applyState(data.election, data.positions || []);
    } catch (e) {
      setLoadError(e.message);
    }
  }, [fetchElection, applyState]);

  /* ── Initial metadata load (before joining) so JoinScreen knows branding/PIN ── */
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchElection();
        setOrg(data.org);
        setElection(data.election);
        setPositions(data.positions || []);
        electionIdRef.current = data.election.id;
      } catch (e) {
        setLoadError(e.message);
      }
    })();
  }, [fetchElection]);

  /* ── Timer expiry detection ── */
  useEffect(() => {
    if (election?.status !== "voting" || !election?.poll_expires_at) {
      setTimerExpired(false);
      return;
    }
    function check() {
      setTimerExpired(new Date(election.poll_expires_at).getTime() <= Date.now());
    }
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [election?.status, election?.poll_expires_at]);

  /* ── Realtime event handling ── */
  const refreshEligibility = useCallback(async () => {
    const h = deviceHashRef.current;
    const id = electionIdRef.current;
    if (!h || !id) return;
    try {
      const res = await fetch("/api/checkin/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ election_id: id, device_hash: h }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.checked_in === true && typeof data.verified === "boolean") {
        setEligible(data.verified);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const onRealtimeEvent = useCallback(
    (event, data) => {
      if (event === "state_change") {
        // Update lightweight state from payload, then fetch candidates/positions.
        refreshAll();
      } else if (event === "purge") {
        const id = electionIdRef.current;
        if (data?.all) {
          setVotedPositions(id, []);
        } else if (data?.position_id) {
          setVotedPositions(
            id,
            getVotedPositions(id).filter((p) => p !== data.position_id)
          );
        }
        setHasVotedThisPosition(false);
        setSelectedCandidate(null);
        refreshAll();
      } else if (event === "checkin_verified") {
        if (data?.device_hash && data.device_hash === deviceHashRef.current) {
          setEligible(true);
        }
      } else if (event === "checkin_revoked") {
        if (data?.device_hash && data.device_hash === deviceHashRef.current) {
          leaveRoom("You were removed from the room by the host.");
        }
      }
    },
    [refreshAll]
  );

  const leaveRoom = useCallback((notice) => {
    try {
      connRef.current?.close();
    } catch {
      /* ignore */
    }
    connRef.current = null;
    deviceHashRef.current = null;
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
    try {
      localStorage.removeItem(VOTER_NAME_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (notice) setSessionNotice(notice);
  }, []);

  /* ── Join: check-in, then connect realtime ── */
  async function handleJoin(displayName, pin) {
    const hash = await getDeviceHash();
    const electionId = electionIdRef.current;
    if (!electionId) throw new Error("Election is still loading. Try again.");

    const res = await fetch("/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ election_id: electionId, display_name: displayName, device_hash: hash, pin }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Check-in failed. Try again.");

    setEligible(Boolean(json.verified));
    setDeviceHash(hash);
    deviceHashRef.current = hash;

    connRef.current = connectElection(electionId, {
      onEvent: onRealtimeEvent,
      onStatus: (status) => {
        if (status === "open") {
          refreshAll();
          refreshEligibility();
        }
      },
    });

    await refreshAll();
    setSessionNotice("");
    setJoined(true);
  }

  /* ── Visibility reconnection ── */
  useEffect(() => {
    if (!joined) return;
    function onVis() {
      if (document.visibilityState === "visible") {
        connRef.current?.resubscribe();
        refreshAll();
        refreshEligibility();
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [joined, refreshAll, refreshEligibility]);

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
    if (!selectedCandidate || !election?.active_position_id || !deviceHash) return;
    setSubmitting(true);
    setSubmitError("");
    await new Promise((r) => setTimeout(r, Math.random() * 400));
    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          election_id: election.id,
          position_id: election.active_position_id,
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
      const id = election.id;
      const voted = getVotedPositions(id);
      if (!voted.includes(election.active_position_id)) {
        voted.push(election.active_position_id);
        setVotedPositions(id, voted);
      }
      setHasVotedThisPosition(true);
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
        <p className="text-slate-500 mt-2 text-sm">{loadError}</p>
      </CenteredCard>
    );
  }
  if (!election) {
    return (
      <CenteredCard>
        <div className="w-10 h-10 mx-auto rounded-full border-2 border-slate-200 border-t-slate-900 animate-spin" />
      </CenteredCard>
    );
  }

  if (!joined) {
    return (
      <JoinScreen org={org} election={election} onJoin={handleJoin} sessionNotice={sessionNotice} />
    );
  }

  const status = election?.status || "waiting";

  /* WAITING / COMPLETE */
  if (status === "completed" || status === "waiting" || !activePosition) {
    if (votingFullyComplete || status === "completed") {
      return (
        <CenteredCard>
          <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-green-50 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 className="font-display font-black text-xl text-slate-900">Voting complete!</h2>
          <p className="text-slate-500 mt-3 text-sm leading-relaxed">
            Thank you for voting in {election.title}.
          </p>
        </CenteredCard>
      );
    }
    return (
      <CenteredCard>
        <div className="w-12 h-12 mx-auto mb-6 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1a` }}>
          <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Waiting for host</h2>
        <p className="text-slate-500 mt-2 text-sm">The next poll will appear here automatically.</p>
      </CenteredCard>
    );
  }

  /* LOCKED / EXPIRED */
  if (status === "locked" || timerExpired) {
    return (
      <CenteredCard>
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-slate-200 flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Voting closed</h2>
        <p className="text-slate-500 mt-1 text-sm">{activePosition?.title} — results are being reviewed.</p>
      </CenteredCard>
    );
  }

  /* VOTED */
  if (hasVotedThisPosition) {
    return (
      <CenteredCard>
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-green-50 flex items-center justify-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Vote submitted!</h2>
        <p className="text-slate-500 mt-1 text-sm">Waiting for host to proceed…</p>
        {election?.poll_expires_at && (
          <div className="mt-6 opacity-60">
            <CountdownTimer expiresAt={election.poll_expires_at} />
          </div>
        )}
      </CenteredCard>
    );
  }

  /* VOTING but not yet eligible (verification pending) */
  if (status === "voting" && !timerExpired && !eligible) {
    return (
      <CenteredCard>
        <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-amber-50 flex items-center justify-center border border-amber-200/80">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h2 className="font-display font-black text-xl text-slate-900">Eligibility pending</h2>
        <p className="text-slate-500 mt-3 text-sm leading-relaxed">
          Your eligibility hasn’t been confirmed yet. Keep this page open — you’ll be able to vote as
          soon as the host verifies you.
        </p>
        {election?.poll_expires_at && (
          <div className="mt-8">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Time remaining</p>
            <CountdownTimer expiresAt={election.poll_expires_at} />
          </div>
        )}
      </CenteredCard>
    );
  }

  /* ACTIVE VOTING */
  return (
    <div className="min-h-dvh bg-slate-50 pb-32">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-lg border-b border-slate-100 px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
              Now voting
            </p>
            <h1 className="font-display font-black text-lg text-slate-900 leading-tight truncate">
              {activePosition?.title}
            </h1>
          </div>
          {election?.poll_expires_at && <CountdownTimer expiresAt={election.poll_expires_at} />}
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 mt-4">
        <p className="text-sm text-slate-500 mb-3 font-medium" id="ballot-label">
          Select one candidate
        </p>
        <div role="radiogroup" aria-labelledby="ballot-label" className="flex flex-col gap-2">
          {candidates.map((c, i) => (
            <div key={c.id} className="animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
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
      </main>

      <div className="fixed bottom-0 inset-x-0 p-4 bg-gradient-to-t from-slate-50 via-slate-50 to-transparent">
        <div className="max-w-lg mx-auto">
          {submitError && (
            <p role="alert" className="mb-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg px-3 py-2 shadow-sm">
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
      </div>
    </div>
  );
}
