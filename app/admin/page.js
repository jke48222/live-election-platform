"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { sortCandidatesByLastName } from "../../lib/candidates-sort";
import { connectElection } from "../../lib/realtime-client";
import { tallySeats } from "../../lib/results";
import {
  clockOffsetMs,
  pollPhase,
  formatClock,
  createLatestGate,
  allPositionsFinalized,
  canResetPosition,
  shouldLoadFinalResults,
  chartColorMap,
  needsVoteRefresh,
  parseTimerSeconds,
  POLL_TIMER_MIN_SEC,
  POLL_TIMER_MAX_SEC,
  ELIGIBILITY_LABELS,
  eligibilityChangePrompts,
  createCoalescer,
  isValidHostPin,
  HOST_PIN_MIN,
  HOST_PIN_MAX,
} from "../_lib/poll";

/* Which election this dashboard controls: ?org=&election= in the URL, else
   NEXT_PUBLIC_DEFAULT_ORG / NEXT_PUBLIC_DEFAULT_ELECTION, else the demo. The
   Workspace keeps the URL in step with the pickers, so a refresh or a shared
   link reopens the same election. */
function resolveTarget() {
  let org = process.env.NEXT_PUBLIC_DEFAULT_ORG || "demo";
  let election = process.env.NEXT_PUBLIC_DEFAULT_ELECTION || "spring-2026";
  if (typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search);
    org = q.get("org") || org;
    election = q.get("election") || election;
  }
  return { org, election };
}

/** Run an async action at most once at a time, whatever fires it (click, Enter, double Enter). */
function useSingleFlight() {
  const busy = useRef(new Set());
  return useCallback(async (key, fn) => {
    if (busy.current.has(key)) return undefined;
    busy.current.add(key);
    try {
      return await fn();
    } finally {
      busy.current.delete(key);
    }
  }, []);
}

const inputBase =
  "w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-base focus:border-brand focus:ring-2 focus:ring-brand/20";

/* ── Auth screen: log in or create an account ── */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function submit(e) {
    e?.preventDefault();
    if (busyRef.current || !email || !password) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onAuthed();
      else setError(data.error || "Something went wrong.");
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-surface">
      <form className="w-full max-w-sm" onSubmit={submit} noValidate>
        <h1 className="font-display font-black text-2xl text-center mb-1">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="text-center text-sm text-muted mb-6">
          {mode === "login" ? "Sign in to run your elections." : "Start running live elections in minutes."}
        </p>
        {mode === "signup" && (
          <>
            <label htmlFor="auth-name" className="block text-sm font-semibold text-ink mb-1">
              Your name
            </label>
            <input
              id="auth-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputBase} mb-3`}
            />
          </>
        )}
        <label htmlFor="auth-email" className="block text-sm font-semibold text-ink mb-1">
          Email
        </label>
        <input
          id="auth-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError("");
          }}
          className={`${inputBase} mb-3`}
          autoFocus
        />
        <label htmlFor="auth-password" className="block text-sm font-semibold text-ink mb-1">
          {mode === "login" ? "Password" : "Password (at least 8 characters)"}
        </label>
        <input
          id="auth-password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError("");
          }}
          className={inputBase}
        />
        {error && (
          <p role="alert" className="text-brand text-sm mt-2 font-medium">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!email || !password || busy}
          className="w-full mt-4 h-12 rounded-xl bg-brand text-white font-bold text-lg enabled:hover:bg-brand-dark disabled:opacity-40 transition-all"
        >
          {busy ? "Please wait…" : mode === "login" ? "Log In" : "Sign Up"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
          className="w-full mt-3 text-sm text-muted hover:text-ink font-medium underline-offset-2 hover:underline"
        >
          {mode === "login" ? "No account? Sign up" : "Already have an account? Log in"}
        </button>
      </form>
    </div>
  );
}

/* ── Onboarding: create an organization ── */
function CreateOrg({ onCreated }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [type, setType] = useState("club");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function slugify(v) {
    return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  async function submit(e) {
    e?.preventDefault();
    if (busyRef.current || !name) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, slug: slug || slugify(name), type }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onCreated(data.org);
      else setError(data.error || "Could not create organization.");
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-md mx-auto bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h2 className="font-display font-black text-xl text-ink mb-1">Create your organization</h2>
      <p className="text-sm text-muted mb-5">This is the home for your elections.</p>
      <label htmlFor="org-name" className="block text-sm font-semibold text-ink mb-1">Name</label>
      <input
        id="org-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSlug(slugify(e.target.value));
          setError("");
        }}
        placeholder="Acme Student Council"
        className={`${inputBase} mb-3`}
      />
      <label htmlFor="org-slug" className="block text-sm font-semibold text-ink mb-1">URL slug</label>
      <input
        id="org-slug"
        value={slug}
        onChange={(e) => setSlug(slugify(e.target.value))}
        placeholder="acme-council"
        className={`${inputBase} mb-3 font-mono`}
      />
      <label htmlFor="org-type" className="block text-sm font-semibold text-ink mb-1">Type</label>
      <select
        id="org-type"
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="w-full h-12 px-4 mb-4 rounded-xl border-2 border-gray-200 focus:border-brand bg-white text-base font-semibold"
      >
        <option value="club">Organization / club</option>
        <option value="college">College / university</option>
        <option value="individual">Individual</option>
      </select>
      {error && <p role="alert" className="text-brand text-sm mb-3 font-medium">{error}</p>}
      <button
        type="submit"
        disabled={!name || busy}
        className="w-full h-12 rounded-xl bg-brand text-white font-bold enabled:hover:bg-brand-dark disabled:opacity-40 transition-all"
      >
        {busy ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}

/* ── Onboarding: create an election ── */
function CreateElection({ orgSlug, onCreated, onCancel }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [eligibility, setEligibility] = useState("pin");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function slugify(v) {
    return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  }

  const ready = title && !(eligibility === "pin" && !isValidHostPin(pin));

  async function submit(e) {
    e?.preventDefault();
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/elections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          org_slug: orgSlug,
          title,
          slug: slug || slugify(title),
          eligibility_mode: eligibility,
          pin: eligibility === "pin" ? pin : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) onCreated(data.election);
      else setError(data.error || "Could not create election.");
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-md mx-auto bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h2 className="font-display font-black text-xl text-ink mb-1">Create an election</h2>
      <p className="text-sm text-muted mb-5">You can add positions and candidates next.</p>
      <label htmlFor="election-title" className="block text-sm font-semibold text-ink mb-1">Title</label>
      <input
        id="election-title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setSlug(slugify(e.target.value));
          setError("");
        }}
        placeholder="Spring 2026 Board Election"
        className={`${inputBase} mb-3`}
      />
      <label htmlFor="election-slug" className="block text-sm font-semibold text-ink mb-1">URL slug</label>
      <input
        id="election-slug"
        value={slug}
        onChange={(e) => setSlug(slugify(e.target.value))}
        placeholder="spring-2026"
        className={`${inputBase} mb-3 font-mono`}
      />
      <label htmlFor="election-eligibility" className="block text-sm font-semibold text-ink mb-1">Voter eligibility</label>
      <select
        id="election-eligibility"
        value={eligibility}
        onChange={(e) => setEligibility(e.target.value)}
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-brand bg-white text-base font-semibold"
      >
        <option value="pin">Room PIN</option>
        <option value="open">Open (anyone with the link)</option>
        <option value="roster_csv">Roster (verify each voter)</option>
      </select>
      {eligibility === "pin" && (
        <>
          <label htmlFor="election-pin" className="block text-sm font-semibold text-ink mb-1">
            Room PIN ({HOST_PIN_MIN} to {HOST_PIN_MAX} digits)
          </label>
          <input
            id="election-pin"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            inputMode="numeric"
            className={`${inputBase} mb-3 text-center tracking-widest font-bold`}
          />
        </>
      )}
      {error && <p role="alert" className="text-brand text-sm mb-3 font-medium">{error}</p>}
      <button
        type="submit"
        disabled={!ready || busy}
        className="w-full h-12 rounded-xl bg-brand text-white font-bold enabled:hover:bg-brand-dark disabled:opacity-40 transition-all"
      >
        {busy ? "Creating…" : "Create election"}
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="w-full mt-3 h-11 rounded-xl border-2 border-gray-300 text-ink font-semibold enabled:hover:bg-gray-50"
        >
          Cancel
        </button>
      )}
    </form>
  );
}

/* ── Charts ──
   Colors come from chartColorMap (one color per candidate in the race). Names
   sit on their own line and wrap, so long or similar names stay readable. */
function VoteBar({ name, count, total, barColor, isLeader }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const fill = count === 0 ? "#E5E7EB" : barColor;
  return (
    <div className="py-1.5" title={name}>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink break-words [overflow-wrap:anywhere]">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-baseline"
            style={{ backgroundColor: barColor }}
            aria-hidden
          />
          {name}
        </span>
        <span className="shrink-0 tabular-nums text-sm font-bold text-ink">
          {count}
          <span className="sr-only"> {count === 1 ? "vote" : "votes"}</span>
        </span>
      </div>
      <div className="h-6 bg-gray-100 rounded-full overflow-hidden" aria-hidden>
        <div
          className="h-full rounded-full bar-fill"
          style={{
            "--bar-width": `${Math.max(pct, 2)}%`,
            width: `${Math.max(pct, 2)}%`,
            backgroundColor: fill,
            boxShadow: isLeader && count > 0 ? "inset 0 0 0 2px rgba(17,24,39,0.35)" : undefined,
          }}
        />
      </div>
    </div>
  );
}

function VotePieChart({ candidates, voteCounts, totalVotes, leaderIds, colorMap }) {
  const active = candidates.filter((c) => c.is_active);
  const cx = 100, cy = 100, r = 88;
  const segments = active.map((c) => ({
    id: c.id,
    name: c.name,
    count: voteCounts[c.id] || 0,
    color: colorMap[c.id] || "#6B7280",
    isLeader: leaderIds.includes(c.id),
  }));
  const label = segments.filter((s) => s.count > 0).map((s) => `${s.name}: ${s.count}`).join(", ");

  if (totalVotes === 0) {
    return (
      <figure className="flex flex-col items-center">
        <svg viewBox="0 0 200 200" className="w-44 h-44 max-w-full shrink-0" role="img" aria-label="No votes yet">
          <circle cx={cx} cy={cy} r={r} fill="#F3F4F6" stroke="#E5E7EB" strokeWidth="2" />
          <text x={cx} y={cy + 5} textAnchor="middle" fill="#4B5563" fontSize="11" fontWeight="600" fontFamily="system-ui, sans-serif">
            No votes yet
          </text>
        </svg>
        <figcaption className="text-xs text-muted mt-2 text-center">Share of live tally</figcaption>
      </figure>
    );
  }

  let angle = -Math.PI / 2;
  const paths = [];
  for (const s of segments) {
    const frac = s.count / totalVotes;
    if (frac <= 0) continue;
    const endAngle = angle + frac * 2 * Math.PI;
    if (frac >= 1 - 1e-6) {
      paths.push(
        <circle key={s.id} cx={cx} cy={cy} r={r} fill={s.color} stroke={s.isLeader ? "#111827" : "#fff"} strokeWidth={s.isLeader ? 2.5 : 1} />
      );
      break;
    }
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = endAngle - angle > Math.PI ? 1 : 0;
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    paths.push(
      <path key={s.id} d={d} fill={s.color} stroke={s.isLeader ? "#111827" : "#fff"} strokeWidth={s.isLeader ? 2.5 : 1} />
    );
    angle = endAngle;
  }

  return (
    <figure className="flex flex-col items-center w-full max-w-[220px] mx-auto md:mx-0">
      <svg viewBox="0 0 200 200" className="w-44 h-44 max-w-full shrink-0 drop-shadow-sm rounded-full" role="img" aria-label={label ? `Vote share: ${label}` : "Vote share"}>
        {paths}
      </svg>
      <figcaption className="w-full mt-3 space-y-1.5">
        <p className="text-xs font-bold text-muted uppercase tracking-wider text-center">Share</p>
        <ul className="text-xs text-ink space-y-1">
          {segments.map((s) => (
            <li key={s.id} className="flex items-start gap-2 min-w-0" title={s.name}>
              <span className="w-2.5 h-2.5 mt-0.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
              <span className="flex-1 min-w-0 font-medium break-words [overflow-wrap:anywhere]">{s.name}</span>
              <span className="tabular-nums font-bold text-muted shrink-0">
                {totalVotes > 0 ? Math.round((s.count / totalVotes) * 100) : 0}%
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Countdown on the server's clock (offsetMs corrects the admin laptop's clock). */
function AdminCountdown({ expiresAt, offsetMs = 0 }) {
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    if (!expiresAt) return;
    function tick() {
      const { remainingSec } = pollPhase({ status: "voting", expiresAt, offsetMs, nowMs: Date.now() });
      setRemaining(remainingSec ?? 0);
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt, offsetMs]);
  if (remaining === null) return null;
  const urgent = remaining <= 10;
  return (
    <span
      role="timer"
      aria-label="Time left in this poll"
      className={`font-display font-black text-3xl tabular-nums ${urgent ? "text-brand" : "text-ink"}`}
    >
      {formatClock(remaining)}
    </span>
  );
}

/* ── Poll timer field. Kept as typed text so a cleared field stays empty
   instead of turning into 0, and Launch or Restart stay off until it holds a
   whole number of seconds in range. ── */
function TimerField({ id, label, value, onChange, valid }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-semibold text-ink" htmlFor={id}>{label}</label>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : `${id}-error`}
          className={`w-24 h-10 px-3 rounded-lg border-2 text-base text-center font-bold focus:border-brand ${valid ? "border-gray-200" : "border-brand"}`}
        />
      </div>
      {!valid && (
        <p id={`${id}-error`} className="text-xs font-medium text-brand mt-1">
          Enter a whole number of seconds from {POLL_TIMER_MIN_SEC} to {POLL_TIMER_MAX_SEC}.
        </p>
      )}
    </div>
  );
}

/* ── Eligibility list (roster entries or access codes) ── */
/* locked: a poll is live or locked, so entries cannot be removed (the server
   answers 409). New access codes can still be generated. */
function RosterList({ entries, onRemove, onClear, showToken, locked = false }) {
  if (!entries || entries.length === 0) {
    return <p className="text-xs text-muted mt-3">No entries yet.</p>;
  }
  const used = entries.filter((e) => e.used_at).length;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-bold text-ink">
          {entries.length} {showToken ? "codes" : "entries"}
          {showToken ? ` · ${used} used` : ""}
        </p>
        <button type="button" onClick={onClear} disabled={locked} className="text-xs font-bold text-brand enabled:hover:underline disabled:opacity-40">Clear all</button>
      </div>
      {locked && showToken && (
        <p className="text-xs text-muted mb-1">Finish the current poll before changing the voter list. New codes can still be generated.</p>
      )}
      <ul className="max-h-48 overflow-y-auto space-y-1 border border-gray-100 rounded-xl p-2 bg-gray-50/50">
        {entries.map((e) => {
          const label = showToken ? e.token : e.identifier;
          return (
            <li key={e.id} className="flex items-center justify-between gap-2 text-sm px-1">
              <span className="font-mono min-w-0 break-words [overflow-wrap:anywhere] text-ink">
                {label}
                {e.used_at && (
                  <span className="ml-2 text-[10px] uppercase font-bold text-amber-800 bg-amber-100 px-1 rounded">used</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => onRemove(e)}
                disabled={locked}
                className="shrink-0 min-h-[28px] min-w-[28px] px-2.5 py-1 rounded-md border border-brand/30 text-xs font-bold text-brand enabled:hover:bg-red-50 disabled:opacity-40"
                aria-label={`Remove ${label}`}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DASHBOARD
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function Dashboard({ orgSlug, electionSlug, onSessionExpired }) {
  const [org, setOrg] = useState(null);
  const [election, setElection] = useState(null); // { id, title, status, active_position_id, poll_expires_at, eligibility_mode }
  const [positions, setPositions] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);
  const [roomPin, setRoomPin] = useState(null); // admin-only read; never in the public election

  const [candidates, setCandidates] = useState([]);
  const [voteCounts, setVoteCounts] = useState({});
  const [totalVotes, setTotalVotes] = useState(0);
  const [newCandidateName, setNewCandidateName] = useState("");
  // The timer field as typed; parseTimerSeconds says whether it can be sent.
  const [timerRaw, setTimerRaw] = useState("60");
  // Which action is in flight ('launch', 'lock', 'remove-candidate', ...), or null.
  const [busyAction, setBusyAction] = useState(null);
  const [selectedLaunchPositionId, setSelectedLaunchPositionId] = useState(null);
  const [finalWinners, setFinalWinners] = useState([]);
  const [finalResultsError, setFinalResultsError] = useState(null);
  const [historyPositionId, setHistoryPositionId] = useState("");
  const [historyCandidates, setHistoryCandidates] = useState([]);
  const [historyVoteCounts, setHistoryVoteCounts] = useState({});
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyWinner, setHistoryWinner] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [memberCheckins, setMemberCheckins] = useState([]);
  const [checkinsLoading, setCheckinsLoading] = useState(false);
  const [checkinsError, setCheckinsError] = useState(null);
  const [checkinRemovingHash, setCheckinRemovingHash] = useState(null);
  const [checkinVerifyingHash, setCheckinVerifyingHash] = useState(null);
  // Wrong PINs, codes and emails in the last few minutes: { recent, window_minutes, slowed }.
  const [checkinFailures, setCheckinFailures] = useState(null);
  const [clearingFailures, setClearingFailures] = useState(false);

  // Ballot builder
  const [builderPositions, setBuilderPositions] = useState([]);
  const [builderLoading, setBuilderLoading] = useState(false);
  const [newPositionTitle, setNewPositionTitle] = useState("");
  const [newCandidateByPos, setNewCandidateByPos] = useState({});

  // Voter eligibility
  const [rosterEntries, setRosterEntries] = useState([]);
  const [rosterText, setRosterText] = useState("");
  const [genCount, setGenCount] = useState(25);
  const [pinDraft, setPinDraft] = useState("");
  // The mode picked in the select but not applied yet (null = the saved mode).
  const [eligDraft, setEligDraft] = useState(null);
  const [eligPinDraft, setEligPinDraft] = useState("");

  const pollInterval = useRef(null);
  const jsonHeaders = { "Content-Type": "application/json" };
  const fetchOpts = { credentials: "include", cache: "no-store" };
  const singleFlight = useSingleFlight();

  /* Each read that can race keeps its own gate: only the newest response lands. */
  const gates = useRef(null);
  if (!gates.current) {
    gates.current = {
      election: createLatestGate(),
      candidates: createLatestGate(),
      votes: createLatestGate(),
      history: createLatestGate(),
      checkins: createLatestGate(),
    };
  }

  const electionId = election?.id || null;

  /* ── Election + positions (public read) ── */
  const fetchElection = useCallback(async () => {
    const token = gates.current.election.begin();
    const sentAt = Date.now();
    let res, json;
    try {
      res = await fetch(
        `/api/election?org=${encodeURIComponent(orgSlug)}&election=${encodeURIComponent(electionSlug)}`,
        { cache: "no-store" }
      );
      json = await res.json().catch(() => ({}));
    } catch {
      return null;
    }
    if (!gates.current.election.isLatest(token)) return null;
    if (!res.ok) {
      setLoadError(json.error || "Election not found.");
      return null;
    }
    setLoadError("");
    setOffsetMs(clockOffsetMs(json.server_now, sentAt, Date.now()));
    setOrg(json.org);
    setElection(json.election);
    setPositions(json.positions || []);
    return json.election;
  }, [orgSlug, electionSlug]);

  /* ── Admin-only settings (the room PIN) ── */
  const fetchSettings = useCallback(async () => {
    if (!electionId) return;
    try {
      const res = await fetch(`/api/elections?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRoomPin(data.election?.pin ?? null);
    } catch {
      /* the panel shows "not loaded" */
    }
  }, [electionId, onSessionExpired]);

  /* ── Candidates for a position (admin → includes inactive) ── */
  const fetchCandidates = useCallback(
    async (positionId) => {
      const token = gates.current.candidates.begin();
      if (!positionId || !electionId) {
        setCandidates([]);
        return;
      }
      try {
        const res = await fetch(
          `/api/candidates?election_id=${electionId}&position_id=${positionId}`,
          fetchOpts
        );
        const data = await res.json().catch(() => ({}));
        if (!gates.current.candidates.isLatest(token)) return;
        setCandidates(sortCandidatesByLastName(data.candidates || []));
      } catch {
        /* keep the last list; the next refresh retries */
      }
    },
    [electionId]
  );

  /* Gated like the other reads: a poll response that was already in flight
     cannot put back older counts, or counts that finalize just cleared. */
  const fetchVotes = useCallback(
    async (positionId) => {
      const token = gates.current.votes.begin();
      if (!positionId || !electionId) {
        setVoteCounts({});
        setTotalVotes(0);
        return;
      }
      try {
        const res = await fetch(
          `/api/vote?election_id=${electionId}&position_id=${positionId}`,
          fetchOpts
        );
        if (res.status === 401) return onSessionExpired();
        if (res.ok) {
          const data = await res.json();
          if (!gates.current.votes.isLatest(token)) return;
          setVoteCounts(data.counts || {});
          setTotalVotes(data.total || 0);
        }
      } catch {
        /* next poll retries */
      }
    },
    [electionId, onSessionExpired]
  );

  const fetchFinalResults = useCallback(async () => {
    if (!electionId) return;
    try {
      const res = await fetch(`/api/results?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      if (!res.ok) {
        setFinalResultsError("Could not load final results.");
        setFinalWinners([]);
        return;
      }
      const data = await res.json();
      setFinalResultsError(null);
      setFinalWinners(data.winners || []);
    } catch {
      setFinalResultsError("Network error loading final results.");
    }
  }, [electionId, onSessionExpired]);

  /* silent: a background refresh (live event or timer) keeps the list on
     screen and does not flash "Refreshing…" or wipe the list on a blip. */
  const fetchCheckins = useCallback(async ({ silent = false } = {}) => {
    if (!electionId) return;
    const token = gates.current.checkins.begin();
    if (!silent) {
      setCheckinsLoading(true);
      setCheckinsError(null);
    }
    try {
      const res = await fetch(`/api/checkin?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!gates.current.checkins.isLatest(token)) return;
      if (!res.ok) {
        if (silent) return;
        setCheckinsError(data.error || "Could not load check-ins.");
        setMemberCheckins([]);
        return;
      }
      setCheckinsError(null);
      setMemberCheckins(data.checkins || []);
      setCheckinFailures(data.failures || null);
      return data.checkins || [];
    } catch {
      if (silent || !gates.current.checkins.isLatest(token)) return;
      setCheckinsError("Network error loading check-ins.");
      setMemberCheckins([]);
    } finally {
      if (gates.current.checkins.isLatest(token)) setCheckinsLoading(false);
    }
  }, [electionId, onSessionExpired]);

  const checkinStats = useMemo(() => {
    let verified = 0, unverified = 0, duplicateNames = 0;
    for (const row of memberCheckins) {
      if (row.verified) verified += 1;
      else unverified += 1;
      if (row.name_duplicate) duplicateNames += 1;
    }
    return { verified, unverified, duplicateNames };
  }, [memberCheckins]);

  const removeCheckin = useCallback(
    async (checkinId, displayName) => {
      if (!confirm(`Remove "${displayName}" from check-in? Their device will need to join again.`)) return;
      setCheckinRemovingHash(checkinId);
      try {
        const res = await fetch("/api/checkin", {
          method: "DELETE",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, id: checkinId }),
        });
        if (res.status === 401) return onSessionExpired();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || "Could not remove check-in.");
          return;
        }
        await fetchCheckins();
      } catch {
        alert("Network error removing check-in.");
      } finally {
        setCheckinRemovingHash(null);
      }
    },
    [electionId, fetchCheckins, onSessionExpired]
  );

  /* Clears the election's wrong-answer count, which ends the slowdown. The
     limits on each device and IP stay. */
  const clearCheckinFailures = useCallback(async () => {
    setClearingFailures(true);
    try {
      const res = await fetch("/api/checkin", {
        method: "PATCH",
        headers: jsonHeaders,
        credentials: "include",
        body: JSON.stringify({ election_id: electionId, reset_failures: true }),
      });
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Could not clear the count.");
        return;
      }
      setCheckinFailures(data.failures || null);
    } catch {
      alert("Network error clearing the count.");
    } finally {
      setClearingFailures(false);
    }
  }, [electionId, onSessionExpired]);

  const verifyCheckin = useCallback(
    async (checkinId, displayName) => {
      if (!confirm(`Confirm that "${displayName}" is eligible to vote?`)) return;
      setCheckinVerifyingHash(checkinId);
      try {
        const res = await fetch("/api/checkin", {
          method: "PATCH",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, id: checkinId }),
        });
        if (res.status === 401) return onSessionExpired();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || "Could not save verification.");
          return;
        }
        await fetchCheckins();
      } catch {
        alert("Network error confirming eligibility.");
      } finally {
        setCheckinVerifyingHash(null);
      }
    },
    [electionId, fetchCheckins, onSessionExpired]
  );

  /* Three reads per position. Each step checks the gate, so switching the
     dropdown mid-load never mixes one position's data with another's. */
  const loadHistoryPosition = useCallback(
    async (positionId) => {
      const gate = gates.current.history;
      const token = gate.begin();
      if (!positionId || !electionId) {
        setHistoryCandidates([]);
        setHistoryVoteCounts({});
        setHistoryTotal(0);
        setHistoryWinner(null);
        setHistoryLoading(false);
        return;
      }
      setHistoryLoading(true);
      try {
        const [cr, vr, wr] = await Promise.all([
          fetch(`/api/candidates?election_id=${electionId}&position_id=${positionId}`, fetchOpts),
          fetch(`/api/vote?election_id=${electionId}&position_id=${positionId}`, fetchOpts),
          fetch(`/api/results?election_id=${electionId}&position_id=${positionId}`, fetchOpts),
        ]);
        if (vr.status === 401 || wr.status === 401) return onSessionExpired();
        const cj = await cr.json().catch(() => ({}));
        const vj = vr.ok ? await vr.json().catch(() => ({})) : {};
        const wj = wr.ok ? await wr.json().catch(() => ({})) : {};
        if (!gate.isLatest(token)) return;
        setHistoryCandidates(sortCandidatesByLastName(cj.candidates || []));
        setHistoryVoteCounts(vj.counts || {});
        setHistoryTotal(vj.total || 0);
        setHistoryWinner(wj.winner ?? null);
      } catch {
        if (gate.isLatest(token)) setHistoryWinner(null);
      } finally {
        if (gate.isLatest(token)) setHistoryLoading(false);
      }
    },
    [electionId, onSessionExpired]
  );

  useEffect(() => {
    loadHistoryPosition(historyPositionId || "");
  }, [historyPositionId, loadHistoryPosition]);

  const incompletePositions = positions
    .filter((p) => !p.is_completed)
    .sort((a, b) => a.sort_order - b.sort_order);

  /* Keep the launch selection valid as positions/completion change. */
  useEffect(() => {
    const incomplete = positions
      .filter((p) => !p.is_completed)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (incomplete.length === 0) {
      setSelectedLaunchPositionId(null);
      return;
    }
    setSelectedLaunchPositionId((prev) =>
      prev && incomplete.some((p) => p.id === prev) ? prev : incomplete[0].id
    );
  }, [positions]);

  const electionFullyDone = allPositionsFinalized(positions);
  // Finalizing the last race sets status 'completed'; the winner list loads then too.
  const loadFinal = shouldLoadFinalResults(election, positions);

  useEffect(() => {
    if (!loadFinal) {
      setFinalWinners([]);
      setFinalResultsError(null);
      return;
    }
    fetchFinalResults();
  }, [loadFinal, fetchFinalResults]);

  function getCurrentPosition() {
    if (!election?.active_position_id) return null;
    return positions.find((p) => p.id === election.active_position_id) || null;
  }

  /* ── Initialize ── */
  useEffect(() => {
    fetchElection();
  }, [fetchElection]);

  useEffect(() => {
    if (electionId) {
      fetchCheckins();
      fetchSettings();
    }
  }, [electionId, fetchCheckins, fetchSettings]);

  /* ── Live updates: the host's console follows the room ──
     New check-ins, verifications and removals refresh the check-in list, and
     state changes (from this tab, a co-host or the server's own lock at the
     deadline) refresh the election. While the socket is down, check-ins are
     polled so a walk-in waiting for verification is never missed. */
  const liveRef = useRef({});
  liveRef.current = { fetchCheckins, fetchElection, fetchVotes };
  useEffect(() => {
    if (!electionId) return;
    /* A burst of arrivals at the door becomes one list request about every
       750 ms, with at most one in flight, not one full list per check-in. */
    const checkinRefresh = createCoalescer(
      () => liveRef.current.fetchCheckins({ silent: true }),
      750
    );
    /* Reload the election, then the counts of whatever poll it shows, so a
       lock or a purge from anywhere never leaves stale counts on screen. */
    const refreshRoom = async () => {
      const el = await liveRef.current.fetchElection();
      if (el?.active_position_id) liveRef.current.fetchVotes(el.active_position_id);
    };
    const conn = connectElection(electionId, {
      onEvent: (event) => {
        if (typeof event !== "string") return;
        if (event.startsWith("checkin_")) checkinRefresh.trigger();
        else if (event === "state_change" || event === "purge") refreshRoom();
      },
      // After each subscribe, on tab focus, every few seconds while the
      // socket is down and every 15 s while it is up.
      onSync: () => {
        checkinRefresh.trigger();
        refreshRoom();
      },
      getTicket: async () => {
        const res = await fetch("/api/realtime/ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ election_id: electionId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ticket) throw new Error(data.error || "No realtime ticket");
        return data.ticket;
      },
    });
    return () => {
      checkinRefresh.cancel();
      conn.close();
    };
  }, [electionId]);

  /* ── Candidates when the active position changes ── */
  useEffect(() => {
    if (!election?.active_position_id) return;
    fetchCandidates(election.active_position_id);
  }, [election?.active_position_id, fetchCandidates]);

  /* ── Vote counts whenever the poll changes state ──
     Not only a new position: voting -> locked (Lock Early, a co-host, the
     server's lock at the deadline) and locked -> voting (Clear & Restart)
     reload too, so the Results panel never keeps the last 2 s poll. */
  const prevElectionRef = useRef(null);
  useEffect(() => {
    const prev = prevElectionRef.current;
    prevElectionRef.current = election;
    if (needsVoteRefresh(prev, election)) fetchVotes(election.active_position_id);
  }, [election, fetchVotes]);

  /* ── Poll vote counts every 2s during active voting ── */
  useEffect(() => {
    if (election?.status === "voting" && election?.active_position_id) {
      pollInterval.current = setInterval(() => {
        fetchVotes(election.active_position_id);
      }, 2000);
    }
    return () => clearInterval(pollInterval.current);
  }, [election?.status, election?.active_position_id, fetchVotes]);

  /* ── Lock when the time runs out, on the server's clock ──
     The server also locks an expired poll on its next read, so this is not
     the only thing that closes the room. */
  const autoLockFired = useRef(false);
  useEffect(() => {
    if (election?.status !== "voting" || !election?.poll_expires_at) {
      autoLockFired.current = false;
      return;
    }
    function check() {
      const { phase } = pollPhase({
        status: "voting",
        expiresAt: election.poll_expires_at,
        offsetMs,
        nowMs: Date.now(),
      });
      if (phase === "closed" && !autoLockFired.current) {
        autoLockFired.current = true;
        fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          // Names the poll it means, so a stale tab cannot lock the next one.
          body: JSON.stringify({
            action: "lock",
            election_id: electionId,
            position_id: election.active_position_id,
            expires_at: election.poll_expires_at,
          }),
        })
          .then(() => {
            fetchElection();
            fetchVotes(election.active_position_id);
          })
          .catch(() => {
            autoLockFired.current = false;
          });
      }
    }
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [election?.status, election?.poll_expires_at, election?.active_position_id, offsetMs, electionId, fetchElection, fetchVotes]);

  /* ── State-mutating action helper ── */
  async function apiCall(action, body = {}) {
    if (!electionId) return;
    setBusyAction(action);
    try {
      let res;
      try {
        res = await fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action, election_id: electionId, ...body }),
        });
      } catch {
        alert("Network error. Check your connection and try again.");
        return;
      }
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || "Action failed");
      const el = await fetchElection();
      // The poll effect also reloads counts on a state change; this covers a
      // refused action where the state did not change but the counts did.
      if (el?.active_position_id) await fetchVotes(el.active_position_id);
    } finally {
      setBusyAction(null);
    }
  }

  async function launchPoll() {
    if (!selectedLaunchPositionId) return;
    const chosen = positions.find((p) => p.id === selectedLaunchPositionId);
    if (!chosen || chosen.is_completed) return;
    const duration = parseTimerSeconds(timerRaw);
    if (duration === null) return;
    await singleFlight("state", () =>
      apiCall("launch", { position_id: selectedLaunchPositionId, duration })
    );
  }
  /* lock, finalize and clear_restart name the poll this page is showing: the
     race, its status and its round (poll_expires_at, which changes on every
     lock and restart). The server refuses with 409 if any has changed since. */
  const livePoll = () =>
    election?.active_position_id
      ? {
          position_id: election.active_position_id,
          expected_status: election.status,
          ...(election.poll_expires_at ? { expires_at: election.poll_expires_at } : {}),
        }
      : {};
  async function lockPoll() {
    // No undo: reopening means Clear & Restart, which deletes the votes cast.
    const { remainingSec } = pollPhase({
      status: election?.status,
      expiresAt: election?.poll_expires_at,
      offsetMs,
      nowMs: Date.now(),
    });
    const left = remainingSec ? ` with ${formatClock(remainingSec)} left` : "";
    if (!confirm(`Close voting now${left}? You cannot reopen this poll without deleting the votes already cast.`)) return;
    await singleFlight("state", () => apiCall("lock", livePoll()));
  }
  async function finalizePosition() {
    await singleFlight("state", async () => {
      await apiCall("finalize", livePoll());
      // Drop any counts request still in flight so it cannot refill the panel.
      gates.current.votes.invalidate();
      setCandidates([]);
      setVoteCounts({});
      setTotalVotes(0);
    });
  }
  async function clearAndRestart() {
    const duration = parseTimerSeconds(timerRaw);
    if (duration === null) return;
    if (!confirm(`This will DELETE all votes for this position and reopen voting with a ${duration} second timer. Are you sure?`)) return;
    await singleFlight("state", () => apiCall("clear_restart", { ...livePoll(), duration }));
  }

  /* ── Ballot builder ── */
  const fetchBuilder = useCallback(async () => {
    if (!electionId) return;
    setBuilderLoading(true);
    try {
      const res = await fetch(`/api/positions?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      setBuilderPositions(data.positions || []);
    } catch {
      /* keep the last list */
    } finally {
      setBuilderLoading(false);
    }
  }, [electionId, onSessionExpired]);

  /* The builder and the launch panel show the same ballot. Any change made
     in one refreshes both, plus the positions list. */
  async function refreshBallot() {
    const launchId = election?.active_position_id || selectedLaunchPositionId;
    await Promise.all([fetchBuilder(), fetchElection(), launchId ? fetchCandidates(launchId) : null]);
  }

  async function toggleCandidate(candidateId, currentActive) {
    try {
      const res = await fetch("/api/candidates", {
        method: "PATCH",
        headers: jsonHeaders,
        credentials: "include",
        body: JSON.stringify({ election_id: electionId, id: candidateId, is_active: !currentActive }),
      });
      if (res.status === 401) return onSessionExpired();
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Could not update candidate.");
        return;
      }
    } catch {
      alert("Network error updating candidate.");
      return;
    }
    await refreshBallot();
  }

  async function addCandidate() {
    const positionId = election?.active_position_id || selectedLaunchPositionId;
    const name = newCandidateName.trim();
    if (!positionId || !name) return;
    await singleFlight("add-candidate", async () => {
      try {
        const res = await fetch("/api/candidates", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, position_id: positionId, name }),
        });
        if (res.status === 401) return onSessionExpired();
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          alert(d.error || "Could not add candidate.");
          return;
        }
      } catch {
        alert("Network error adding candidate.");
        return;
      }
      setNewCandidateName("");
      await refreshBallot();
    });
  }

  async function removeCandidate(c) {
    if (!confirm(`Remove "${c.name}" from this position permanently? Any votes already cast for them will be deleted, and the people who chose them cannot vote again in this race until its votes are cleared.`)) return;
    setBusyAction("remove-candidate");
    try {
      let res;
      try {
        res = await fetch("/api/candidates", {
          method: "DELETE",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, id: c.id }),
        });
      } catch {
        alert("Network error removing candidate.");
        return;
      }
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Could not remove candidate");
        return;
      }
      await refreshBallot();
    } finally {
      setBusyAction(null);
    }
  }

  async function resetHistoryPosition() {
    if (!historyPositionId) return;
    if (!canResetPosition(election)) {
      alert("Finish or finalize the current poll first.");
      return;
    }
    if (!confirm("Clear all votes for this position and mark it as not finalized?")) return;
    await singleFlight("state", () => apiCall("reset_position", { position_id: historyPositionId }));
    await loadHistoryPosition(historyPositionId);
    await fetchFinalResults();
  }

  async function resetAllResults() {
    if (!confirm("Delete ALL votes, reopen every position, and return to waiting? Voter devices clear saved votes. This cannot be undone.")) return;
    await singleFlight("state", () => apiCall("reset_all_results"));
    await fetchFinalResults();
    await loadHistoryPosition(historyPositionId || "");
  }

  async function builderApi(method, path, payload) {
    try {
      const res = await fetch(path, { method, headers: jsonHeaders, credentials: "include", body: JSON.stringify(payload) });
      if (res.status === 401) { onSessionExpired(); return null; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { alert(data.error || "Action failed"); return null; }
      return data;
    } catch {
      alert("Network error. Check your connection and try again.");
      return null;
    }
  }

  async function addPosition() {
    const title = newPositionTitle.trim();
    if (!title) return;
    await singleFlight("add-position", async () => {
      if (await builderApi("POST", "/api/positions", { election_id: electionId, title })) {
        setNewPositionTitle("");
        await refreshBallot();
      }
    });
  }
  /* The title input is uncontrolled, so a refused or blank rename must put
     the saved title back, or the builder shows a name the server never took. */
  async function renamePosition(input, p) {
    const next = (input.value || "").trim();
    if (next === p.title) {
      input.value = p.title;
      return;
    }
    if (!next) {
      input.value = p.title;
      alert("A position needs a title. The old title was kept.");
      return;
    }
    if (await builderApi("PATCH", "/api/positions", { election_id: electionId, id: p.id, title: next })) {
      await refreshBallot();
    } else {
      input.value = p.title;
    }
  }
  async function movePosition(id, move) {
    if (await builderApi("PATCH", "/api/positions", { election_id: electionId, id, move })) {
      await refreshBallot();
    }
  }
  async function deletePosition(id, title) {
    if (!confirm(`Delete position "${title}" and all its candidates?`)) return;
    if (await builderApi("DELETE", "/api/positions", { election_id: electionId, id })) {
      await refreshBallot();
    }
  }
  async function addBuilderCandidate(positionId) {
    const name = (newCandidateByPos[positionId] || "").trim();
    if (!name) return;
    await singleFlight(`add-candidate:${positionId}`, async () => {
      if (await builderApi("POST", "/api/candidates", { election_id: electionId, position_id: positionId, name })) {
        setNewCandidateByPos((m) => ({ ...m, [positionId]: "" }));
        await refreshBallot();
      }
    });
  }
  async function deleteBuilderCandidate(id, name) {
    if (!confirm(`Remove candidate "${name}"?`)) return;
    if (await builderApi("DELETE", "/api/candidates", { election_id: electionId, id })) {
      await refreshBallot();
    }
  }

  /* ── Voter eligibility ── */
  const fetchRoster = useCallback(async () => {
    if (!electionId) return;
    try {
      const res = await fetch(`/api/roster?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      setRosterEntries(data.entries || []);
    } catch {
      /* keep the last list */
    }
  }, [electionId, onSessionExpired]);

  /* The select only stages a mode; nothing changes until the host presses
     "Change mode" and accepts the confirmation, because a change signs every
     checked-in voter out. */
  const savedMode = election?.eligibility_mode || "pin";
  const draftMode = eligDraft ?? savedMode;
  const modeChangePending = draftMode !== savedMode;
  const draftNeedsPin = modeChangePending && draftMode === "pin" && !roomPin;
  function cancelEligibilityChange() {
    setEligDraft(null);
    setEligPinDraft("");
  }
  async function applyEligibilityChange() {
    if (!modeChangePending) return;
    const pin = eligPinDraft.trim();
    if (draftNeedsPin && !isValidHostPin(pin)) return;
    await singleFlight("eligibility", async () => {
      // Count from the server, not the last list this tab loaded.
      const fresh = await fetchCheckins({ silent: true });
      const count = Array.isArray(fresh) ? fresh.length : memberCheckins.length;
      const prompts = eligibilityChangePrompts(savedMode, draftMode, count);
      for (const text of prompts) {
        if (!confirm(text)) return;
      }
      const payload = { election_id: electionId, eligibility_mode: draftMode };
      if (draftNeedsPin) payload.pin = pin;
      const r = await builderApi("PATCH", "/api/elections", payload);
      if (!r) return;
      setEligDraft(null);
      setEligPinDraft("");
      if (r.election && "pin" in r.election) setRoomPin(r.election.pin ?? null);
      await fetchElection();
      await fetchRoster();
      await fetchSettings();
      await fetchCheckins();
    });
  }
  async function savePin() {
    const next = pinDraft.trim();
    if (!isValidHostPin(next)) return;
    await singleFlight("save-pin", async () => {
      const r = await builderApi("PATCH", "/api/elections", { election_id: electionId, pin: next });
      if (r) {
        setPinDraft("");
        setRoomPin(r.election?.pin ?? next);
        await fetchElection();
        // A new PIN clears the wrong-answer count on the server.
        await fetchCheckins({ silent: true });
      }
    });
  }
  async function addRoster() {
    const text = rosterText.trim();
    if (!text) return;
    await singleFlight("add-roster", async () => {
      const r = await builderApi("POST", "/api/roster", { election_id: electionId, text });
      if (r) {
        setRosterText("");
        await fetchRoster();
        if (typeof r.added === "number") alert(`Added ${r.added} of ${r.submitted} (duplicates skipped).`);
      }
    });
  }
  async function generateCodes() {
    const n = Math.max(1, Math.min(2000, Number(genCount) || 0));
    await singleFlight("generate-codes", async () => {
      if (await builderApi("POST", "/api/roster", { election_id: electionId, generate_codes: n })) {
        await fetchRoster();
      }
    });
  }
  async function removeRosterEntry(entry) {
    // A used entry is someone's check-in: removing it signs that voter out.
    if (entry.used_at) {
      const what = entry.token ? `code ${entry.token}` : `"${entry.identifier}"`;
      if (!confirm(`Remove ${what}? It was used to check in, so that voter is signed out and must join again.`)) return;
    }
    if (await builderApi("DELETE", "/api/roster", { election_id: electionId, id: entry.id })) {
      await fetchRoster();
      if (entry.used_at) await fetchCheckins({ silent: true });
    }
  }
  async function clearRoster() {
    if (!confirm("Clear the entire eligibility list?")) return;
    if (await builderApi("DELETE", "/api/roster", { election_id: electionId, all: true })) await fetchRoster();
  }

  /* ═══════════ RENDER ═══════════ */
  const status = election?.status || "waiting";
  const currentPosition = getCurrentPosition();
  const voterPath = `/${orgSlug}/${electionSlug}`;
  const canResetPolls = canResetPosition(election);
  const selectedLaunchPosition = selectedLaunchPositionId
    ? positions.find((p) => p.id === selectedLaunchPositionId)
    : null;
  const busy = busyAction !== null;
  const pollActive = status === "voting" || status === "locked";
  const timerSeconds = parseTimerSeconds(timerRaw);

  /* Pre-poll: load candidates for the selected position. */
  useEffect(() => {
    if (status !== "waiting" || !selectedLaunchPositionId) return;
    fetchCandidates(selectedLaunchPositionId);
  }, [status, selectedLaunchPositionId, fetchCandidates]);

  /* Load the ballot builder while the election is idle. */
  useEffect(() => {
    if (status === "waiting" || status === "draft" || status === "completed") fetchBuilder();
  }, [status, fetchBuilder]);

  /* Load the eligibility list. It stays on screen during a poll, read-only
     apart from the room PIN and new access codes. */
  useEffect(() => {
    fetchRoster();
  }, [status, fetchRoster]);

  const colorMap = useMemo(() => chartColorMap(candidates), [candidates]);
  const historyColorMap = useMemo(() => chartColorMap(historyCandidates), [historyCandidates]);

  /* Seats go to the top max_winners candidates, the rule /api/results uses,
     so a two-seat race with a 2/2/1 vote is not shown as a tie. */
  const seats = Math.max(1, Number(currentPosition?.max_winners) || 1);
  const activeCandidates = candidates.filter((c) => c.is_active);
  const seatResult = tallySeats(activeCandidates, voteCounts, seats);
  const leaderNames = new Set(seatResult.names);
  const leaders = activeCandidates.filter((c) => leaderNames.has(c.name)).map((c) => c.id);
  const isTie = seatResult.is_tie;
  const historyMaxVotes = Math.max(0, ...Object.values(historyVoteCounts));
  const historyLeaders = Object.entries(historyVoteCounts).filter(([, c]) => c === historyMaxVotes && historyMaxVotes > 0).map(([id]) => id);

  /* Voter eligibility. While a poll is live or locked the mode and the voter
     list are fixed (the server answers 409), but the host can still change
     the room PIN and hand out new access codes to late arrivals. */
  const eligibilitySection = election ? (
    <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
      <h2 className="font-display font-black text-lg text-ink mb-3">Voter eligibility</h2>
      <label htmlFor="elig-mode" className="block text-sm font-semibold text-ink mb-1">
        How voters are verified
      </label>
      <select
        id="elig-mode"
        value={draftMode}
        onChange={(e) => {
          setEligDraft(e.target.value === savedMode ? null : e.target.value);
          setEligPinDraft("");
        }}
        disabled={pollActive}
        aria-describedby={pollActive ? "elig-locked" : modeChangePending ? "elig-pending" : undefined}
        className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-base font-semibold focus:border-brand disabled:opacity-60"
      >
        {Object.entries(ELIGIBILITY_LABELS).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      {pollActive && (
        <p id="elig-locked" className="text-xs text-muted mt-1">
          Finish the current poll before changing how voters check in.
        </p>
      )}

      {modeChangePending && !pollActive && (
        <form
          className="mt-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyEligibilityChange();
          }}
        >
          <p id="elig-pending" className="text-sm text-amber-900 font-medium">
            Not changed yet. Changing the mode signs out{" "}
            {memberCheckins.length > 0
              ? `all ${memberCheckins.length} checked-in voter${memberCheckins.length === 1 ? "" : "s"}`
              : "every checked-in voter"}
            , and they must join again.
            {draftMode === "open" && " Open mode lets anyone with the link vote."}
          </p>
          {draftNeedsPin && (
            <div className="mt-3">
              <label htmlFor="elig-pin" className="block text-xs font-semibold text-ink mb-1">
                Room PIN for voters ({HOST_PIN_MIN} to {HOST_PIN_MAX} digits)
              </label>
              <input
                id="elig-pin"
                value={eligPinDraft}
                onChange={(e) => setEligPinDraft(e.target.value.replace(/\D/g, "").slice(0, 8))}
                inputMode="numeric"
                autoComplete="off"
                className="w-full h-11 px-3 rounded-lg border-2 border-gray-200 bg-white text-base focus:border-brand text-center tracking-widest font-bold"
              />
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button
              type="submit"
              disabled={draftNeedsPin && !isValidHostPin(eligPinDraft)}
              className="flex-1 min-h-11 px-3 rounded-xl bg-ink text-white font-semibold disabled:opacity-30"
            >
              Change mode
            </button>
            <button
              type="button"
              onClick={cancelEligibilityChange}
              className="flex-1 min-h-11 px-3 rounded-xl border-2 border-gray-300 bg-white text-ink font-semibold"
            >
              Keep current mode
            </button>
          </div>
        </form>
      )}

      {election?.eligibility_mode === "open" && (
        <p className="text-sm text-muted mt-3">Anyone with the voter link can vote. There is no check-in.</p>
      )}

      {election?.eligibility_mode === "pin" && (
        <div className="mt-3">
          <p className="text-sm text-ink mb-2">
            Current room PIN:{" "}
            <span className="font-mono font-bold text-lg tracking-widest">
              {roomPin || <span className="font-body text-sm tracking-normal text-muted">not set</span>}
            </span>
          </p>
          <form
            className="flex gap-2 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              savePin();
            }}
          >
            <div className="flex-1 min-w-0">
              <label htmlFor="new-pin" className="block text-xs font-semibold text-muted mb-1">
                New PIN ({HOST_PIN_MIN} to {HOST_PIN_MAX} digits)
              </label>
              <input
                id="new-pin"
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 8))}
                inputMode="numeric"
                className="w-full h-11 px-3 rounded-lg border-2 border-gray-200 text-base focus:border-brand text-center tracking-widest font-bold"
              />
            </div>
            <button type="submit" disabled={!isValidHostPin(pinDraft.trim())} className="h-11 px-4 shrink-0 rounded-lg bg-ink text-white font-semibold disabled:opacity-30">
              Save PIN
            </button>
          </form>
        </div>
      )}

      {(election?.eligibility_mode === "roster_csv" || election?.eligibility_mode === "email_magic_link") && (
        <div className="mt-4">
          <label htmlFor="roster-text" className="block text-sm text-muted mb-2">
            {election.eligibility_mode === "email_magic_link"
              ? "Paste eligible emails, one per line. Only these emails can vote."
              : "Paste eligible names, one per line. Matching names are auto-verified; others wait for your manual verify."}
          </label>
          <textarea
            id="roster-text"
            disabled={pollActive}
            aria-describedby={pollActive ? "roster-locked" : undefined}
            value={rosterText}
            onChange={(e) => setRosterText(e.target.value)}
            rows={4}
            placeholder={election.eligibility_mode === "email_magic_link" ? "ada@example.com\nalan@example.com" : "Ada Lovelace\nAlan Turing"}
            className="w-full px-3 py-2 rounded-xl border-2 border-gray-200 focus:border-brand text-base sm:text-sm font-mono disabled:bg-gray-50 disabled:text-muted"
          />
          <button type="button" onClick={addRoster} disabled={pollActive || !rosterText.trim()} className="mt-2 h-11 px-5 rounded-xl bg-brand text-white font-bold disabled:opacity-40">
            Add to list
          </button>
          {pollActive && (
            <p id="roster-locked" className="text-xs text-muted mt-1">
              Finish the current poll before changing the voter list.
            </p>
          )}
          <RosterList entries={rosterEntries} onRemove={removeRosterEntry} onClear={clearRoster} showToken={false} locked={pollActive} />
        </div>
      )}

      {election?.eligibility_mode === "access_code" && (
        <div className="mt-4">
          <p className="text-sm text-muted mb-2">
            Generate single-use codes and hand them out. Each code works on one device.
          </p>
          <div className="flex gap-2 items-end">
            <div>
              <label htmlFor="code-count" className="block text-xs font-semibold text-muted mb-1">
                How many codes
              </label>
              <input
                id="code-count"
                type="number"
                min={1}
                max={2000}
                value={genCount}
                onChange={(e) => setGenCount(Number(e.target.value))}
                className="w-28 h-11 px-3 rounded-lg border-2 border-gray-200 text-base focus:border-brand text-center font-bold"
              />
            </div>
            <button onClick={generateCodes} className="h-11 px-5 rounded-xl bg-brand text-white font-bold">
              Generate codes
            </button>
          </div>
          <RosterList entries={rosterEntries} onRemove={removeRosterEntry} onClear={clearRoster} showToken={true} locked={pollActive} />
        </div>
      )}
    </section>
  ) : null;

  if (loadError && !election) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface px-6">
        <p role="alert" className="text-sm text-muted text-center">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface">
      <header className="bg-white border-b border-gray-100 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display font-black text-lg text-ink truncate" title={org?.name || undefined}>
              {org?.name ? `${org.name} · Control` : "Election Control"}
            </h1>
            <p className="text-xs text-muted font-semibold uppercase tracking-wider truncate" title={election?.title || undefined}>
              {election?.title}
              {status === "waiting" && " · Pre-Poll"}
              {status === "voting" && " · Live Voting"}
              {status === "locked" && " · Results"}
              {status === "completed" && " · Complete"}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {status === "voting" && election?.poll_expires_at && (
              <AdminCountdown expiresAt={election.poll_expires_at} offsetMs={offsetMs} />
            )}
            <span
              aria-hidden
              className={`inline-block w-3 h-3 rounded-full ${
                status === "voting" ? "bg-green-500 animate-pulse" : status === "locked" ? "bg-gray-400" : "bg-yellow-400"
              }`}
            />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Progress */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <h2 className="text-sm font-bold text-muted uppercase tracking-wider mb-3">Election Progress</h2>
          {positions.length === 0 ? (
            <p className="text-sm text-muted">
              No positions yet. Add them in <strong>Ballot setup</strong> below.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {positions.map((p) => (
                <span
                  key={p.id}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-full max-w-full break-words [overflow-wrap:anywhere] ${
                    p.is_completed
                      ? "bg-green-100 text-green-800"
                      : p.id === election?.active_position_id
                      ? "bg-brand text-white"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {p.title}
                  {p.is_completed && <span className="sr-only"> (finalized)</span>}
                  {p.id === election?.active_position_id && <span className="sr-only"> (live)</span>}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Voter link */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <h2 className="text-sm font-bold text-muted uppercase tracking-wider mb-2">Voter link</h2>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-sm bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 truncate">
              {voterPath}
            </code>
            <a
              href={voterPath}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-bold text-brand px-3 py-2 rounded-lg border border-brand/30 hover:bg-red-50 transition-colors shrink-0"
            >
              Open
            </a>
          </div>
        </section>

        {/* Ballot setup (builder), while idle */}
        {(status === "waiting" || status === "draft" || status === "completed") && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display font-black text-lg text-ink">Ballot setup</h2>
              {builderLoading && <span className="text-xs text-muted" role="status">Saving…</span>}
            </div>
            {builderPositions.length === 0 && (
              <p className="text-sm text-muted mb-3">
                Add the positions voters will choose for, then add candidates to each.
              </p>
            )}
            <div className="space-y-4">
              {builderPositions.map((p, idx) => (
                <div key={p.id} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      key={p.title}
                      defaultValue={p.title}
                      onBlur={(e) => renamePosition(e.currentTarget, p)}
                      maxLength={120}
                      className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-gray-200 text-base font-bold text-ink focus:border-brand"
                      aria-label={`Position title: ${p.title}`}
                    />
                    <button onClick={() => movePosition(p.id, "up")} disabled={idx === 0} className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 text-ink disabled:opacity-30" aria-label={`Move ${p.title} up`}>↑</button>
                    <button onClick={() => movePosition(p.id, "down")} disabled={idx === builderPositions.length - 1} className="h-9 w-9 shrink-0 rounded-lg border border-gray-200 text-ink disabled:opacity-30" aria-label={`Move ${p.title} down`}>↓</button>
                    <button onClick={() => deletePosition(p.id, p.title)} className="shrink-0 text-xs font-bold text-brand px-2 py-2 rounded-lg border border-brand/30 hover:bg-red-50" aria-label={`Delete position ${p.title}`}>Delete</button>
                  </div>
                  <ul className="space-y-1 mb-2 pl-1">
                    {p.candidates.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 break-words [overflow-wrap:anywhere] text-ink">
                          {c.name}
                          {!c.is_active && <span className="text-gray-600"> (inactive)</span>}
                        </span>
                        <button onClick={() => deleteBuilderCandidate(c.id, c.name)} className="text-xs font-bold text-brand px-2 py-0.5 rounded hover:bg-red-50 shrink-0" aria-label={`Remove ${c.name} from ${p.title}`}>Remove</button>
                      </li>
                    ))}
                    {p.candidates.length === 0 && <li className="text-xs text-muted">No candidates yet.</li>}
                  </ul>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      addBuilderCandidate(p.id);
                    }}
                  >
                    <label htmlFor={`add-cand-${p.id}`} className="sr-only">Add a candidate to {p.title}</label>
                    <input
                      id={`add-cand-${p.id}`}
                      value={newCandidateByPos[p.id] || ""}
                      onChange={(e) => setNewCandidateByPos((m) => ({ ...m, [p.id]: e.target.value }))}
                      placeholder="Add candidate…"
                      maxLength={255}
                      className="flex-1 min-w-0 h-9 px-2 rounded-lg border border-gray-200 text-base sm:text-sm focus:border-brand"
                    />
                    <button type="submit" disabled={!(newCandidateByPos[p.id] || "").trim()} className="h-9 px-3 rounded-lg bg-ink text-white text-sm font-semibold disabled:opacity-30">Add</button>
                  </form>
                </div>
              ))}
            </div>
            <form
              className="flex gap-2 mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                addPosition();
              }}
            >
              <label htmlFor="new-position" className="sr-only">New position title</label>
              <input
                id="new-position"
                value={newPositionTitle}
                onChange={(e) => setNewPositionTitle(e.target.value)}
                placeholder="New position (e.g. President)"
                maxLength={120}
                className="flex-1 min-w-0 h-11 px-3 rounded-xl border-2 border-gray-200 text-base focus:border-brand"
              />
              <button type="submit" disabled={!newPositionTitle.trim()} className="h-11 px-5 shrink-0 rounded-xl bg-brand text-white font-bold disabled:opacity-40">Add position</button>
            </form>
          </section>
        )}

        {/* Voter eligibility, while idle (during a poll it sits above check-in) */}
        {!pollActive && eligibilitySection}

        {/* Pre-poll: launch */}
        {status === "waiting" && selectedLaunchPosition && incompletePositions.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-lg text-ink mb-4">Launch poll</h2>
            <div className="mb-4">
              <label htmlFor="launch-pos" className="text-sm font-semibold text-ink block mb-2">
                Position for this poll
              </label>
              <select
                id="launch-pos"
                value={selectedLaunchPositionId || ""}
                onChange={(e) => setSelectedLaunchPositionId(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-base text-ink font-semibold focus:border-brand focus:ring-2 focus:ring-brand/20"
              >
                {incompletePositions.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>

            <p className="text-xs font-bold text-muted uppercase tracking-wider mb-3 break-words [overflow-wrap:anywhere]">
              Candidates for {selectedLaunchPosition.title}
            </p>
            <div className="space-y-2 mb-4">
              {candidates.length === 0 && (
                <p className="text-sm text-muted">No candidates yet. Add them here or in Ballot setup.</p>
              )}
              {candidates.map((c) => (
                <div key={c.id} className="flex items-center gap-2 min-h-[48px] px-3 py-2 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={c.is_active}
                      onChange={() => toggleCandidate(c.id, c.is_active)}
                      className="w-5 h-5 accent-brand rounded shrink-0"
                    />
                    <span className={`font-semibold min-w-0 break-words [overflow-wrap:anywhere] ${c.is_active ? "text-ink" : "text-gray-500 line-through"}`}>
                      {c.name}
                      {!c.is_active && <span className="sr-only"> (off the ballot)</span>}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeCandidate(c)}
                    disabled={busy}
                    className="shrink-0 text-xs font-bold text-brand px-3 py-2 rounded-lg border border-transparent hover:bg-red-50 hover:border-red-100 disabled:opacity-40 transition-colors"
                    aria-label={`Remove ${c.name} from ballot`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <form
              className="flex gap-2 mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                addCandidate();
              }}
            >
              <label htmlFor="floor-nomination" className="sr-only">Floor nomination name</label>
              <input
                id="floor-nomination"
                type="text"
                placeholder="Floor nomination name…"
                value={newCandidateName}
                onChange={(e) => setNewCandidateName(e.target.value)}
                maxLength={255}
                className="flex-1 min-w-0 h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-base focus:border-brand focus:ring-2 focus:ring-brand/20"
              />
              <button
                type="submit"
                disabled={!newCandidateName.trim()}
                className="h-12 px-4 shrink-0 rounded-xl bg-ink text-white font-semibold enabled:hover:bg-gray-800 disabled:opacity-30 transition-all"
              >
                Add
              </button>
            </form>

            <TimerField id="timer-dur" label="Timer (seconds):" value={timerRaw} onChange={setTimerRaw} valid={timerSeconds !== null} />

            <button
              onClick={launchPoll}
              disabled={busy || timerSeconds === null || candidates.filter((c) => c.is_active).length === 0}
              className="w-full min-h-14 px-4 py-3 rounded-xl bg-brand text-white font-bold text-lg leading-tight shadow-lg shadow-brand/25
                         break-words [overflow-wrap:anywhere] enabled:hover:bg-brand-dark disabled:opacity-40 transition-all"
            >
              {busyAction === "launch" ? "Launching…" : `Launch poll: ${selectedLaunchPosition.title}`}
            </button>
          </section>
        )}

        {/* Locked: results + actions */}
        {status === "locked" && currentPosition && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="font-display font-black text-lg text-ink min-w-0 break-words [overflow-wrap:anywhere]">
                Results: {currentPosition.title}
              </h2>
              <p className="font-display font-black text-3xl text-ink tabular-nums shrink-0">
                {totalVotes}
                <span className="sr-only"> votes</span>
              </p>
            </div>
            <div className="space-y-1 mb-4">
              {candidates
                .filter((c) => c.is_active)
                .sort((a, b) => (voteCounts[b.id] || 0) - (voteCounts[a.id] || 0))
                .map((c) => (
                  <VoteBar key={c.id} name={c.name} count={voteCounts[c.id] || 0} total={totalVotes} barColor={colorMap[c.id]} isLeader={leaders.includes(c.id)} />
                ))}
            </div>
            {seats > 1 && (
              <p className="text-sm text-muted mb-3">
                {seats} seats.{" "}
                {!isTie && seatResult.winners.length > 0 && `Winning: ${seatResult.winners.join(", ")}.`}
              </p>
            )}
            {isTie && (
              <div className="bg-red-50 border-2 border-brand rounded-xl p-3 mb-4" role="status">
                <p className="font-bold text-brand text-sm">
                  {seats > 1
                    ? `Tie for the last ${seatResult.open_seats === 1 ? "seat" : `${seatResult.open_seats} seats`}: ${seatResult.tied.join(", ")}. A runoff may be required.`
                    : "Tie. A runoff may be required."}
                </p>
              </div>
            )}
            <TimerField id="timer-dur-restart" label="Restart timer (seconds):" value={timerRaw} onChange={setTimerRaw} valid={timerSeconds !== null} />
            <div className="flex gap-2">
              <button onClick={clearAndRestart} disabled={busy || timerSeconds === null} className="flex-1 min-h-12 px-2 rounded-xl bg-red-50 border-2 border-brand text-brand font-bold enabled:hover:bg-red-100 disabled:opacity-40 transition-all">
                Clear &amp; Restart
              </button>
              <button onClick={finalizePosition} disabled={busy} className="flex-1 min-h-12 px-2 rounded-xl bg-brand text-white font-bold enabled:hover:bg-brand-dark disabled:opacity-40 transition-all">
                Finalize position
              </button>
            </div>
          </section>
        )}

        {/* Active voting: live telemetry */}
        {status === "voting" && currentPosition && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="font-display font-black text-lg text-ink min-w-0 break-words [overflow-wrap:anywhere]">{currentPosition.title}</h2>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted font-semibold uppercase">Total Votes</p>
                <p className="font-display font-black text-3xl text-ink tabular-nums">{totalVotes}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_min(220px,100%)] gap-6 lg:gap-8 mb-6 items-start">
              <div className="space-y-1 min-w-0">
                {candidates.filter((c) => c.is_active).map((c) => (
                  <VoteBar key={c.id} name={c.name} count={voteCounts[c.id] || 0} total={totalVotes} barColor={colorMap[c.id]} isLeader={leaders.includes(c.id)} />
                ))}
              </div>
              <VotePieChart candidates={candidates} voteCounts={voteCounts} totalVotes={totalVotes} leaderIds={leaders} colorMap={colorMap} />
            </div>
            <button onClick={lockPoll} disabled={busy} className="w-full h-12 rounded-xl bg-ink text-white font-bold enabled:hover:bg-gray-800 disabled:opacity-40 transition-all">
              Lock Early
            </button>
          </section>
        )}

        {/* Review past polls */}
        {positions.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="text-sm font-bold text-muted uppercase tracking-wider mb-3">Review past polls</h2>
            <label htmlFor="history-pos" className="sr-only">Position to review</label>
            <select
              id="history-pos"
              value={historyPositionId}
              onChange={(e) => setHistoryPositionId(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-base text-ink font-semibold mb-4 focus:border-brand focus:ring-2 focus:ring-brand/20"
            >
              <option value="">Select a position…</option>
              {[...positions].sort((a, b) => a.sort_order - b.sort_order).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}{p.is_completed ? " (finalized)" : ""}
                </option>
              ))}
            </select>

            {historyLoading && historyPositionId && <p className="text-sm text-muted mb-2" role="status">Loading…</p>}

            {historyPositionId && !historyLoading && historyWinner && (
              <>
                <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-4">
                  <p className="text-xs font-bold text-muted uppercase tracking-wider mb-1">Winner (active ballot)</p>
                  <p className="font-display font-black text-lg text-ink break-words [overflow-wrap:anywhere]">
                    {historyWinner.display}
                    {historyWinner.is_tie && <span className="text-amber-800 font-semibold text-base ml-2">(tie)</span>}
                  </p>
                  <p className="text-xs text-muted mt-2">
                    {historyWinner.is_completed ? "Finalized" : "Not finalized yet"} · {historyTotal} total {historyTotal === 1 ? "vote" : "votes"} cast
                  </p>
                </div>
                <p className="text-xs font-bold text-muted uppercase tracking-wider mb-2">All candidates (vote counts)</p>
                <div className="space-y-1 mb-4">
                  {[...historyCandidates]
                    .sort((a, b) => (historyVoteCounts[b.id] || 0) - (historyVoteCounts[a.id] || 0))
                    .map((c) => (
                      <VoteBar key={c.id} name={c.is_active ? c.name : `${c.name} (inactive)`} count={historyVoteCounts[c.id] || 0} total={Math.max(historyTotal, 1)} barColor={historyColorMap[c.id]} isLeader={historyLeaders.includes(c.id)} />
                    ))}
                </div>
                <button
                  type="button"
                  onClick={resetHistoryPosition}
                  disabled={busy || !canResetPolls}
                  aria-describedby={!canResetPolls ? "reset-help" : undefined}
                  className="w-full h-12 rounded-xl border-2 border-brand text-brand font-bold enabled:hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Reset this poll
                </button>
                {!canResetPolls && (
                  <p id="reset-help" className="text-xs text-muted mt-2 text-center">
                    A poll can be reset once the live or locked poll is finalized.
                  </p>
                )}
              </>
            )}

            {historyPositionId && !historyLoading && !historyWinner && (
              <p className="text-sm text-muted">Could not load results for this position.</p>
            )}

            <div className="mt-6 pt-4 border-t border-gray-100">
              <button type="button" onClick={resetAllResults} disabled={busy} className="w-full h-11 rounded-xl bg-ink text-white font-semibold text-sm enabled:hover:bg-gray-800 disabled:opacity-40 transition-all">
                Reset entire election
              </button>
              <p className="text-xs text-muted text-center mt-2">Removes all votes and un-finalizes every position. Voter devices clear saved votes.</p>
            </div>
          </section>
        )}

        {/* All positions complete: winner list */}
        {(status === "waiting" || status === "completed") && electionFullyDone && (
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-xl text-ink mb-1 text-center">Election complete</h2>
            <p className="text-muted text-sm text-center mb-6">
              {positions.length === 1 ? "The only position is finalized." : `All ${positions.length} positions finalized.`}{" "}
              Plurality winner per position, ties noted.
            </p>
            {finalResultsError && <p role="alert" className="text-brand text-sm text-center font-medium mb-4">{finalResultsError}</p>}
            <ul className="space-y-3">
              {finalWinners.map((w) => (
                <li key={w.position_id} className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 pb-3 border-b border-gray-100 last:border-0 last:pb-0">
                  <span className="text-sm font-bold text-ink min-w-0 break-words [overflow-wrap:anywhere] sm:max-w-[45%]">{w.title}</span>
                  <span className="text-sm text-muted sm:text-right min-w-0 break-words [overflow-wrap:anywhere]">
                    <span className="font-semibold text-ink">{w.display}</span>
                    {w.is_tie && <span className="ml-2 text-amber-800 font-semibold">(tie)</span>}
                    {w.vote_count > 0 && (
                      <span className="text-muted font-normal ml-1 tabular-nums">· {w.vote_count} {w.vote_count === 1 ? "vote" : "votes"}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {finalWinners.length === 0 && !finalResultsError && <p className="text-muted text-sm text-center" role="status">Loading results…</p>}
            <button type="button" onClick={resetAllResults} disabled={busy} className="w-full mt-8 h-12 rounded-xl border-2 border-gray-300 text-ink font-bold enabled:hover:bg-gray-50 disabled:opacity-40 transition-all">
              Reset entire election
            </button>
          </section>
        )}

        {pollActive && eligibilitySection}

        {/* Member check-in */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold text-muted uppercase tracking-wider">Voter check-in</h2>
            <button type="button" onClick={() => fetchCheckins()} disabled={checkinsLoading} className="text-xs font-bold text-brand px-3 py-1.5 rounded-lg border border-brand/30 hover:bg-red-50 disabled:opacity-40 transition-colors">
              {checkinsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {checkinsError && <p role="alert" className="text-brand text-sm font-medium mb-2">{checkinsError}</p>}
          {checkinFailures?.slowed && (
            <div role="alert" className="mb-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-amber-900 font-medium min-w-0 flex-1">
                {election?.eligibility_mode === "pin"
                  ? `Someone is guessing the room PIN (${checkinFailures.recent} wrong in ${checkinFailures.window_minutes} minutes). Change the PIN.`
                  : `Someone is guessing at check-in (${checkinFailures.recent} wrong answers in ${checkinFailures.window_minutes} minutes).`}{" "}
                Wrong answers are slowed down; right ones are not.
              </p>
              <button
                type="button"
                onClick={clearCheckinFailures}
                disabled={clearingFailures}
                className="shrink-0 min-h-11 px-3 rounded-lg border-2 border-amber-400 bg-white text-sm font-bold text-amber-900 enabled:hover:bg-amber-100 disabled:opacity-40"
              >
                {clearingFailures ? "Clearing…" : "Clear"}
              </button>
            </div>
          )}
          {!checkinsLoading && !checkinsError && memberCheckins.length === 0 && (
            <p className="text-sm text-muted">No one has checked in yet. New check-ins appear here on their own.</p>
          )}
          {memberCheckins.length > 0 && (
            <>
              <p className="text-xs font-bold text-ink mb-2 tabular-nums" aria-live="polite">
                {memberCheckins.length} checked in
                {checkinStats.unverified > 0 && <span className="ml-2 font-semibold text-amber-800">· {checkinStats.unverified} unverified</span>}
                {checkinStats.duplicateNames > 0 && <span className="ml-2 font-semibold text-violet-900">· {checkinStats.duplicateNames} duplicate name{checkinStats.duplicateNames === 1 ? "" : "s"}</span>}
              </p>
              <ul className="max-h-56 overflow-y-auto space-y-1.5 border border-gray-100 rounded-xl p-3 bg-gray-50/50">
                {memberCheckins.map((row) => (
                  <li
                    key={row.id}
                    className={`text-sm flex flex-wrap items-center justify-between gap-2 min-w-0 rounded-lg px-2 py-1.5 -mx-2 ${
                      row.name_duplicate && !row.verified
                        ? "bg-amber-50 border border-amber-200/80 ring-2 ring-violet-300/80 ring-inset"
                        : row.name_duplicate
                        ? "bg-violet-50 border border-violet-200/90"
                        : !row.verified
                        ? "bg-amber-50 border border-amber-200/80"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                      <span className="font-medium text-ink min-w-0 break-words [overflow-wrap:anywhere]">{row.display_name}</span>
                      {row.name_duplicate && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-violet-900 bg-violet-200/90 px-1.5 py-0.5 rounded">Duplicate name</span>
                      )}
                      {row.verified ? (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-green-800 bg-green-100 px-1.5 py-0.5 rounded">Verified</span>
                      ) : (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-900 bg-amber-200/90 px-1.5 py-0.5 rounded">Unverified</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <span className="text-xs text-muted tabular-nums">
                        {row.updated_at ? new Date(row.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
                      </span>
                      {!row.verified && (
                        <button
                          type="button"
                          onClick={() => verifyCheckin(row.id, row.display_name)}
                          disabled={checkinVerifyingHash === row.id || checkinRemovingHash === row.id}
                          className="text-xs font-bold text-green-800 px-2 py-1 rounded-md border border-green-700/35 hover:bg-green-50 disabled:opacity-40 transition-colors"
                          aria-label={`Verify ${row.display_name}`}
                        >
                          {checkinVerifyingHash === row.id ? "…" : "Verify"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeCheckin(row.id, row.display_name)}
                        disabled={checkinRemovingHash === row.id || checkinVerifyingHash === row.id}
                        className="text-xs font-bold text-brand px-2 py-1 rounded-md border border-brand/40 hover:bg-red-50 disabled:opacity-40 transition-colors"
                        aria-label={`Remove ${row.display_name} from check-in`}
                      >
                        {checkinRemovingHash === row.id ? "…" : "Remove"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

/* ── Workspace: pick an org + election (or onboard), then render the dashboard ── */
function Workspace({ me, reloadMe, onLogout }) {
  const orgs = me.orgs || [];
  const target = useMemo(resolveTarget, []);

  const initialOrg = orgs.find((o) => o.slug === target.org)?.slug || orgs[0]?.slug || "";
  const [orgSlug, setOrgSlug] = useState(initialOrg);
  const [elections, setElections] = useState(null); // null = loading
  const [electionSlug, setElectionSlug] = useState("");
  const [creatingElection, setCreatingElection] = useState(false);
  // Where the URL should point once the picked org's elections load.
  const wantedElection = useRef(target.election);
  // 'push' after the host picks from the menus (Back returns to the last one); else 'replace'.
  const navMode = useRef("replace");
  const orgSlugRef = useRef(orgSlug);
  orgSlugRef.current = orgSlug;

  const loadElections = useCallback(async (slug) => {
    if (!slug) return;
    setElections(null);
    let list = [];
    try {
      const res = await fetch(`/api/elections?org=${encodeURIComponent(slug)}`, { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      list = data.elections || [];
    } catch {
      /* show the empty state */
    }
    setElections(list);
    setElectionSlug((prev) => {
      const wanted = wantedElection.current;
      if (wanted && list.some((e) => e.slug === wanted)) return wanted;
      if (prev && list.some((e) => e.slug === prev)) return prev;
      return list[0]?.slug || "";
    });
    setCreatingElection(list.length === 0);
  }, []);

  useEffect(() => {
    if (orgSlug) loadElections(orgSlug);
  }, [orgSlug, loadElections]);

  /* Keep ?org=&election= in step with the pickers. */
  useEffect(() => {
    if (!orgSlug || !electionSlug || elections === null) return;
    if (!elections.some((e) => e.slug === electionSlug)) return;
    wantedElection.current = electionSlug;
    const url = new URL(window.location.href);
    if (url.searchParams.get("org") === orgSlug && url.searchParams.get("election") === electionSlug) return;
    url.searchParams.set("org", orgSlug);
    url.searchParams.set("election", electionSlug);
    const state = { org: orgSlug, election: electionSlug };
    if (navMode.current === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
    navMode.current = "replace";
  }, [orgSlug, electionSlug, elections]);

  /* Back and Forward switch the dashboard to the election in the URL. */
  useEffect(() => {
    function onPop() {
      const q = new URLSearchParams(window.location.search);
      const org = q.get("org");
      const el = q.get("election");
      if (el) wantedElection.current = el;
      navMode.current = "replace";
      setCreatingElection(false);
      if (org && org !== orgSlugRef.current && orgs.some((o) => o.slug === org)) {
        setElections(null);
        setElectionSlug("");
        setOrgSlug(org); // loadElections then picks wantedElection
      } else if (el) {
        setElectionSlug(el);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [orgs]);

  if (orgs.length === 0) {
    return (
      <div className="min-h-dvh bg-surface py-10 px-4">
        <TopBar me={me} onLogout={onLogout} />
        <CreateOrg
          onCreated={async (org) => {
            await reloadMe();
            setOrgSlug(org.slug);
          }}
        />
      </div>
    );
  }

  // While the create form is open the menu shows "New election", so picking
  // the current election again fires a change and closes the form.
  const menuElection = creatingElection ? "__new__" : electionSlug;

  return (
    <div className="min-h-dvh bg-surface">
      <TopBar
        me={me}
        onLogout={onLogout}
        orgs={orgs}
        orgSlug={orgSlug}
        onOrgChange={(v) => {
          if (v === orgSlug) return;
          navMode.current = "push";
          wantedElection.current = "";
          // Clear the old org's election first so no dashboard opens on a mixed pair.
          setElections(null);
          setElectionSlug("");
          setOrgSlug(v);
        }}
        elections={elections || []}
        electionSlug={menuElection}
        onElectionChange={(v) => {
          if (v === "__new__") setCreatingElection(true);
          else {
            navMode.current = "push";
            setCreatingElection(false);
            setElectionSlug(v);
          }
        }}
      />
      {creatingElection || (elections && elections.length === 0) ? (
        <div className="py-10 px-4">
          <CreateElection
            orgSlug={orgSlug}
            onCancel={elections && elections.length > 0 ? () => setCreatingElection(false) : undefined}
            onCreated={async (el) => {
              navMode.current = "push";
              wantedElection.current = el.slug;
              setCreatingElection(false);
              await loadElections(orgSlug);
              setElectionSlug(el.slug);
            }}
          />
        </div>
      ) : elections === null ? (
        <div className="py-20 text-center text-sm text-muted" role="status">Loading…</div>
      ) : electionSlug ? (
        <Dashboard key={`${orgSlug}/${electionSlug}`} orgSlug={orgSlug} electionSlug={electionSlug} onSessionExpired={onLogout} />
      ) : null}
    </div>
  );
}

function TopBar({ me, onLogout, orgs, orgSlug, onOrgChange, elections, electionSlug, onElectionChange }) {
  return (
    <header className="bg-white border-b border-gray-100 px-4 py-2.5">
      <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {orgs && orgs.length > 0 && (
            <select
              value={orgSlug}
              onChange={(e) => onOrgChange(e.target.value)}
              className="h-9 px-2 max-w-full rounded-lg border border-gray-200 bg-white text-base sm:text-sm font-semibold"
              aria-label="Organization"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.slug}>{o.name}</option>
              ))}
            </select>
          )}
          {elections && (
            <select
              value={electionSlug || ""}
              onChange={(e) => onElectionChange(e.target.value)}
              className="h-9 px-2 max-w-full rounded-lg border border-gray-200 bg-white text-base sm:text-sm font-semibold"
              aria-label="Election"
            >
              {elections.map((e) => (
                <option key={e.id} value={e.slug}>{e.title}</option>
              ))}
              <option value="__new__">＋ New election…</option>
            </select>
          )}
        </div>
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs text-muted truncate max-w-[160px]" title={me.user.email}>{me.user.email}</span>
          <button onClick={onLogout} className="shrink-0 text-xs font-bold text-brand px-2.5 py-1 rounded-lg border border-brand/30 hover:bg-red-50 transition-colors">
            Log out
          </button>
        </div>
      </div>
    </header>
  );
}

/* ── Admin page entry ── */
export default function AdminPage() {
  const [me, setMe] = useState(undefined); // undefined = loading, {user:null} = logged out, {user,orgs} = in

  const reloadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => ({ user: null }));
      setMe(data);
    } catch {
      setMe({ user: null });
    }
  }, []);

  useEffect(() => {
    reloadMe();
  }, [reloadMe]);

  const onLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* cookie expires on its own */
    }
    setMe({ user: null });
  }, []);

  if (me === undefined) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface">
        <p className="text-sm text-muted" role="status">Loading…</p>
      </div>
    );
  }
  if (!me.user) return <AuthScreen onAuthed={reloadMe} />;
  return <Workspace me={me} reloadMe={reloadMe} onLogout={onLogout} />;
}
