"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { sortCandidatesByLastName } from "../../lib/candidates-sort";

/* Which election this dashboard controls. Defaults to the demo election; a
   proper org dashboard + election picker replaces this in Phase 2/4. Override
   via ?org=&election= or NEXT_PUBLIC_DEFAULT_ORG / NEXT_PUBLIC_DEFAULT_ELECTION. */
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

/* ── Auth screen: log in or create an account ── */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login"); // 'login' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
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
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
      <div className="w-full max-w-sm">
        <h1 className="font-display font-black text-2xl text-center mb-1">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="text-center text-sm text-uga-gray-mid mb-6">
          {mode === "login" ? "Sign in to run your elections." : "Start running live elections in minutes."}
        </p>
        {mode === "signup" && (
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 bg-white focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
          />
        )}
        <input
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError("");
          }}
          className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 bg-white focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
          autoFocus
        />
        <input
          type="password"
          placeholder={mode === "login" ? "Password" : "Password (min 8 characters)"}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
        />
        {error && <p className="text-uga-red text-sm mt-2 font-medium">{error}</p>}
        <button
          onClick={submit}
          disabled={!email || !password || busy}
          className="w-full mt-4 h-12 rounded-xl bg-uga-red text-white font-bold text-lg enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
        >
          {busy ? "Please wait…" : mode === "login" ? "Log In" : "Sign Up"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
          className="w-full mt-3 text-sm text-uga-gray-mid hover:text-uga-black font-medium"
        >
          {mode === "login" ? "No account? Sign up" : "Already have an account? Log in"}
        </button>
      </div>
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

  function slugify(v) {
    return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  async function submit() {
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h2 className="font-display font-black text-xl text-uga-black mb-1">Create your organization</h2>
      <p className="text-sm text-uga-gray-mid mb-5">This is the home for your elections.</p>
      <label className="block text-sm font-semibold text-uga-black mb-1">Name</label>
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSlug(slugify(e.target.value));
          setError("");
        }}
        placeholder="Acme Student Council"
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
      />
      <label className="block text-sm font-semibold text-uga-black mb-1">URL slug</label>
      <input
        value={slug}
        onChange={(e) => setSlug(slugify(e.target.value))}
        placeholder="acme-council"
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red focus:ring-2 focus:ring-uga-red/20 font-mono text-sm"
      />
      <label className="block text-sm font-semibold text-uga-black mb-1">Type</label>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="w-full h-12 px-4 mb-4 rounded-xl border-2 border-gray-200 focus:border-uga-red bg-white font-semibold"
      >
        <option value="club">Organization / club</option>
        <option value="college">College / university</option>
        <option value="individual">Individual</option>
      </select>
      {error && <p className="text-uga-red text-sm mb-3 font-medium">{error}</p>}
      <button
        onClick={submit}
        disabled={!name || busy}
        className="w-full h-12 rounded-xl bg-uga-red text-white font-bold enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
      >
        {busy ? "Creating…" : "Create organization"}
      </button>
    </div>
  );
}

/* ── Onboarding: create an election ── */
function CreateElection({ orgSlug, onCreated }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [eligibility, setEligibility] = useState("pin");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function slugify(v) {
    return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  }

  async function submit() {
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
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h2 className="font-display font-black text-xl text-uga-black mb-1">Create an election</h2>
      <p className="text-sm text-uga-gray-mid mb-5">You can add positions and candidates next.</p>
      <label className="block text-sm font-semibold text-uga-black mb-1">Title</label>
      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setSlug(slugify(e.target.value));
          setError("");
        }}
        placeholder="Spring 2026 Board Election"
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
      />
      <label className="block text-sm font-semibold text-uga-black mb-1">URL slug</label>
      <input
        value={slug}
        onChange={(e) => setSlug(slugify(e.target.value))}
        placeholder="spring-2026"
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red font-mono text-sm"
      />
      <label className="block text-sm font-semibold text-uga-black mb-1">Voter eligibility</label>
      <select
        value={eligibility}
        onChange={(e) => setEligibility(e.target.value)}
        className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red bg-white font-semibold"
      >
        <option value="pin">Room PIN</option>
        <option value="open">Open (anyone with the link)</option>
        <option value="roster_csv">Roster (verify each voter)</option>
      </select>
      {eligibility === "pin" && (
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="Room PIN (digits)"
          inputMode="numeric"
          className="w-full h-12 px-4 mb-3 rounded-xl border-2 border-gray-200 focus:border-uga-red text-center tracking-widest font-bold"
        />
      )}
      {error && <p className="text-uga-red text-sm mb-3 font-medium">{error}</p>}
      <button
        onClick={submit}
        disabled={!title || (eligibility === "pin" && pin.length < 4) || busy}
        className="w-full h-12 rounded-xl bg-uga-red text-white font-bold enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
      >
        {busy ? "Creating…" : "Create election"}
      </button>
    </div>
  );
}

/* ── Chart helpers (unchanged) ── */
const CANDIDATE_CHART_COLORS = [
  "#BA0C2F", "#1D4ED8", "#047857", "#B45309", "#7C3AED", "#BE185D",
  "#0D9488", "#CA8A04", "#4338CA", "#C2410C", "#0369A1", "#15803D",
];
function candidateChartColorForId(candidateId) {
  const s = String(candidateId);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CANDIDATE_CHART_COLORS[h % CANDIDATE_CHART_COLORS.length];
}

function VoteBar({ name, count, total, barColor, isLeader }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const fill = count === 0 ? "#E5E7EB" : barColor;
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="w-36 truncate text-sm font-semibold text-uga-black">{name}</span>
      <div className="flex-1 h-7 bg-gray-100 rounded-full overflow-hidden">
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
      <span className="w-10 text-right tabular-nums text-sm font-bold text-uga-black">{count}</span>
    </div>
  );
}

function VotePieChart({ candidates, voteCounts, totalVotes, leaderIds }) {
  const active = candidates.filter((c) => c.is_active);
  const cx = 100, cy = 100, r = 88;
  const segments = active.map((c) => ({
    id: c.id,
    name: c.name,
    count: voteCounts[c.id] || 0,
    color: candidateChartColorForId(c.id),
    isLeader: leaderIds.includes(c.id),
  }));
  const label = segments.filter((s) => s.count > 0).map((s) => `${s.name}: ${s.count}`).join(", ");

  if (totalVotes === 0) {
    return (
      <figure className="flex flex-col items-center">
        <svg viewBox="0 0 200 200" className="w-44 h-44 max-w-full shrink-0" role="img" aria-label="No votes yet">
          <circle cx={cx} cy={cy} r={r} fill="#F3F4F6" stroke="#E5E7EB" strokeWidth="2" />
          <text x={cx} y={cy + 5} textAnchor="middle" fill="#9CA3AF" fontSize="11" fontWeight="600" fontFamily="system-ui, sans-serif">
            No votes yet
          </text>
        </svg>
        <figcaption className="text-xs text-uga-gray-mid mt-2 text-center">Share of live tally</figcaption>
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
        <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider text-center">Share</p>
        <ul className="text-xs text-uga-black space-y-1">
          {segments.map((s) => (
            <li key={s.id} className="flex items-center gap-2 min-w-0">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
              <span className="truncate flex-1 font-medium">{s.name}</span>
              <span className="tabular-nums font-bold text-uga-gray-mid shrink-0">
                {totalVotes > 0 ? Math.round((s.count / totalVotes) * 100) : 0}%
              </span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function AdminCountdown({ expiresAt }) {
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    if (!expiresAt) return;
    const target = new Date(expiresAt).getTime();
    function tick() {
      setRemaining(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    }
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (remaining === null) return null;
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const urgent = remaining <= 10;
  return (
    <span className={`font-display font-black text-3xl tabular-nums ${urgent ? "text-uga-red" : "text-uga-black"}`}>
      {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
    </span>
  );
}

/* ── Eligibility list (roster entries or access codes) ── */
function RosterList({ entries, onRemove, onClear, showToken }) {
  if (!entries || entries.length === 0) {
    return <p className="text-xs text-uga-gray-mid mt-3">No entries yet.</p>;
  }
  const used = entries.filter((e) => e.used_at).length;
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-bold text-uga-black">
          {entries.length} {showToken ? "codes" : "entries"}
          {showToken ? ` · ${used} used` : ""}
        </p>
        <button onClick={onClear} className="text-xs font-bold text-uga-red hover:underline">Clear all</button>
      </div>
      <ul className="max-h-48 overflow-y-auto space-y-1 border border-gray-100 rounded-xl p-2 bg-gray-50/50">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 text-sm px-1">
            <span className="font-mono truncate text-uga-black">
              {showToken ? e.token : e.identifier}
              {e.used_at && (
                <span className="ml-2 text-[10px] uppercase font-bold text-amber-800 bg-amber-100 px-1 rounded">used</span>
              )}
            </span>
            <button onClick={() => onRemove(e.id)} className="text-xs text-uga-red hover:underline shrink-0">remove</button>
          </li>
        ))}
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

  const [candidates, setCandidates] = useState([]);
  const [voteCounts, setVoteCounts] = useState({});
  const [totalVotes, setTotalVotes] = useState(0);
  const [newCandidateName, setNewCandidateName] = useState("");
  const [timerDuration, setTimerDuration] = useState(60);
  const [loading, setLoading] = useState(false);
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

  const pollInterval = useRef(null);
  const jsonHeaders = { "Content-Type": "application/json" };
  const fetchOpts = { credentials: "include" };

  const electionId = election?.id || null;

  /* ── Election + positions (public read) ── */
  const fetchElection = useCallback(async () => {
    const res = await fetch(
      `/api/election?org=${encodeURIComponent(orgSlug)}&election=${encodeURIComponent(electionSlug)}`
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoadError(json.error || "Election not found.");
      return null;
    }
    setLoadError("");
    setOrg(json.org);
    setElection(json.election);
    setPositions(json.positions || []);
    return json.election;
  }, [orgSlug, electionSlug]);

  /* ── Candidates for a position (admin → includes inactive) ── */
  const fetchCandidates = useCallback(
    async (positionId) => {
      if (!positionId || !electionId) {
        setCandidates([]);
        return;
      }
      const res = await fetch(
        `/api/candidates?election_id=${electionId}&position_id=${positionId}`,
        fetchOpts
      );
      const data = await res.json().catch(() => ({}));
      setCandidates(sortCandidatesByLastName(data.candidates || []));
    },
    [electionId]
  );

  const fetchVotes = useCallback(
    async (positionId) => {
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

  const fetchCheckins = useCallback(async () => {
    if (!electionId) return;
    setCheckinsLoading(true);
    setCheckinsError(null);
    try {
      const res = await fetch(`/api/checkin?election_id=${electionId}`, fetchOpts);
      if (res.status === 401) return onSessionExpired();
      const data = await res.json();
      if (!res.ok) {
        setCheckinsError(data.error || "Could not load check-ins.");
        setMemberCheckins([]);
        return;
      }
      setMemberCheckins(data.checkins || []);
    } catch {
      setCheckinsError("Network error loading check-ins.");
      setMemberCheckins([]);
    } finally {
      setCheckinsLoading(false);
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
    async (deviceHash, displayName) => {
      if (!confirm(`Remove "${displayName}" from check-in? Their device will need to join again.`)) return;
      setCheckinRemovingHash(deviceHash);
      try {
        const res = await fetch("/api/checkin", {
          method: "DELETE",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, device_hash: deviceHash }),
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

  const verifyCheckin = useCallback(
    async (deviceHash, displayName) => {
      if (!confirm(`Confirm that "${displayName}" is eligible to vote?`)) return;
      setCheckinVerifyingHash(deviceHash);
      try {
        const res = await fetch("/api/checkin", {
          method: "PATCH",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ election_id: electionId, device_hash: deviceHash }),
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

  const loadHistoryPosition = useCallback(
    async (positionId) => {
      if (!positionId || !electionId) {
        setHistoryCandidates([]);
        setHistoryVoteCounts({});
        setHistoryTotal(0);
        setHistoryWinner(null);
        return;
      }
      setHistoryLoading(true);
      try {
        const cr = await fetch(
          `/api/candidates?election_id=${electionId}&position_id=${positionId}`,
          fetchOpts
        );
        const cj = await cr.json().catch(() => ({}));
        setHistoryCandidates(sortCandidatesByLastName(cj.candidates || []));

        const vr = await fetch(
          `/api/vote?election_id=${electionId}&position_id=${positionId}`,
          fetchOpts
        );
        if (vr.status === 401) return onSessionExpired();
        if (vr.ok) {
          const j = await vr.json();
          setHistoryVoteCounts(j.counts || {});
          setHistoryTotal(j.total || 0);
        } else {
          setHistoryVoteCounts({});
          setHistoryTotal(0);
        }

        const wr = await fetch(
          `/api/results?election_id=${electionId}&position_id=${positionId}`,
          fetchOpts
        );
        if (wr.status === 401) return onSessionExpired();
        setHistoryWinner(wr.ok ? (await wr.json()).winner ?? null : null);
      } finally {
        setHistoryLoading(false);
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

  const electionFullyDone = positions.length > 0 && positions.every((p) => p.is_completed);

  useEffect(() => {
    if (election?.status !== "waiting" || !electionFullyDone) {
      setFinalWinners([]);
      setFinalResultsError(null);
      return;
    }
    fetchFinalResults();
  }, [election?.status, electionFullyDone, fetchFinalResults]);

  function getCurrentPosition() {
    if (!election?.active_position_id) return null;
    return positions.find((p) => p.id === election.active_position_id) || null;
  }

  /* ── Initialize ── */
  useEffect(() => {
    fetchElection();
  }, [fetchElection]);

  useEffect(() => {
    if (electionId) fetchCheckins();
  }, [electionId, fetchCheckins]);

  /* ── Candidates & votes when the active position changes ── */
  useEffect(() => {
    if (!election?.active_position_id) return;
    fetchCandidates(election.active_position_id);
    fetchVotes(election.active_position_id);
  }, [election?.active_position_id, fetchCandidates, fetchVotes]);

  /* ── Poll vote counts every 2s during active voting ── */
  useEffect(() => {
    if (election?.status === "voting" && election?.active_position_id) {
      pollInterval.current = setInterval(() => {
        fetchVotes(election.active_position_id);
      }, 2000);
    }
    return () => clearInterval(pollInterval.current);
  }, [election?.status, election?.active_position_id, fetchVotes]);

  /* ── Auto-lock when timer expires ── */
  const autoLockFired = useRef(false);
  useEffect(() => {
    if (election?.status !== "voting" || !election?.poll_expires_at) {
      autoLockFired.current = false;
      return;
    }
    const targetMs = new Date(election.poll_expires_at).getTime();
    function check() {
      if (Date.now() >= targetMs && !autoLockFired.current) {
        autoLockFired.current = true;
        fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action: "lock", election_id: electionId }),
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
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [election?.status, election?.poll_expires_at, electionId, fetchElection, fetchVotes]);

  /* ── State-mutating action helper ── */
  async function apiCall(action, body = {}) {
    if (!electionId) return;
    setLoading(true);
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
        alert("Network error — check your connection and try again.");
        return;
      }
      if (res.status === 401) return onSessionExpired();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || "Action failed");
      await fetchElection();
    } finally {
      setLoading(false);
    }
  }

  async function launchPoll() {
    if (!selectedLaunchPositionId) return;
    const chosen = positions.find((p) => p.id === selectedLaunchPositionId);
    if (!chosen || chosen.is_completed) return;
    await apiCall("launch", { position_id: selectedLaunchPositionId, duration: timerDuration });
  }
  async function lockPoll() {
    await apiCall("lock");
  }
  async function finalizePosition() {
    await apiCall("finalize");
    setCandidates([]);
    setVoteCounts({});
    setTotalVotes(0);
  }
  async function clearAndRestart() {
    if (!confirm("This will DELETE all votes for this position and reopen voting. Are you sure?")) return;
    await apiCall("clear_restart", { duration: timerDuration });
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
    const pid = election?.active_position_id || selectedLaunchPositionId || incompletePositions[0]?.id;
    if (pid) await fetchCandidates(pid);
  }

  async function addCandidate() {
    const positionId = election?.active_position_id || selectedLaunchPositionId;
    const name = newCandidateName.trim();
    if (!positionId || !name) return;
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
    await fetchCandidates(positionId);
  }

  async function removeCandidate(c) {
    if (!confirm(`Remove "${c.name}" from this position permanently? Any votes already cast for them will be deleted.`)) return;
    setLoading(true);
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
      const pid = selectedLaunchPositionId;
      if (pid) await fetchCandidates(pid);
    } finally {
      setLoading(false);
    }
  }

  async function resetHistoryPosition() {
    if (!historyPositionId) return;
    if (election?.status !== "waiting" || election?.active_position_id) {
      alert("Finish or finalize the current poll first.");
      return;
    }
    if (!confirm("Clear all votes for this position and mark it as not finalized?")) return;
    await apiCall("reset_position", { position_id: historyPositionId });
    await loadHistoryPosition(historyPositionId);
    await fetchFinalResults();
  }

  async function resetAllResults() {
    if (!confirm("Delete ALL votes, reopen every position, and return to waiting? Voter devices clear saved votes. This cannot be undone.")) return;
    await apiCall("reset_all_results");
    await fetchFinalResults();
    await loadHistoryPosition(historyPositionId || "");
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
    } finally {
      setBuilderLoading(false);
    }
  }, [electionId, onSessionExpired]);

  async function builderApi(method, path, payload) {
    const res = await fetch(path, { method, headers: jsonHeaders, credentials: "include", body: JSON.stringify(payload) });
    if (res.status === 401) { onSessionExpired(); return null; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || "Action failed"); return null; }
    return data;
  }

  async function addPosition() {
    const title = newPositionTitle.trim();
    if (!title) return;
    if (await builderApi("POST", "/api/positions", { election_id: electionId, title })) {
      setNewPositionTitle("");
      await fetchBuilder();
      await fetchElection();
    }
  }
  async function renamePosition(id, title) {
    const next = (title || "").trim();
    if (!next) return;
    if (await builderApi("PATCH", "/api/positions", { election_id: electionId, id, title: next })) {
      await fetchBuilder();
      await fetchElection();
    }
  }
  async function movePosition(id, move) {
    if (await builderApi("PATCH", "/api/positions", { election_id: electionId, id, move })) {
      await fetchBuilder();
      await fetchElection();
    }
  }
  async function deletePosition(id, title) {
    if (!confirm(`Delete position "${title}" and all its candidates?`)) return;
    if (await builderApi("DELETE", "/api/positions", { election_id: electionId, id })) {
      await fetchBuilder();
      await fetchElection();
    }
  }
  async function addBuilderCandidate(positionId) {
    const name = (newCandidateByPos[positionId] || "").trim();
    if (!name) return;
    if (await builderApi("POST", "/api/candidates", { election_id: electionId, position_id: positionId, name })) {
      setNewCandidateByPos((m) => ({ ...m, [positionId]: "" }));
      await fetchBuilder();
    }
  }
  async function deleteBuilderCandidate(id, name) {
    if (!confirm(`Remove candidate "${name}"?`)) return;
    if (await builderApi("DELETE", "/api/candidates", { election_id: electionId, id })) {
      await fetchBuilder();
    }
  }

  /* ── Voter eligibility ── */
  const fetchRoster = useCallback(async () => {
    if (!electionId) return;
    const res = await fetch(`/api/roster?election_id=${electionId}`, fetchOpts);
    if (res.status === 401) return onSessionExpired();
    const data = await res.json().catch(() => ({}));
    setRosterEntries(data.entries || []);
  }, [electionId, onSessionExpired]);

  async function changeEligibility(mode) {
    if (await builderApi("PATCH", "/api/elections", { election_id: electionId, eligibility_mode: mode })) {
      await fetchElection();
      await fetchRoster();
    }
  }
  async function savePin() {
    if (!pinDraft.trim()) return;
    if (await builderApi("PATCH", "/api/elections", { election_id: electionId, pin: pinDraft.trim() })) {
      setPinDraft("");
      await fetchElection();
    }
  }
  async function addRoster() {
    const text = rosterText.trim();
    if (!text) return;
    const r = await builderApi("POST", "/api/roster", { election_id: electionId, text });
    if (r) {
      setRosterText("");
      await fetchRoster();
      if (typeof r.added === "number") alert(`Added ${r.added} of ${r.submitted} (duplicates skipped).`);
    }
  }
  async function generateCodes() {
    const n = Math.max(1, Math.min(2000, Number(genCount) || 0));
    if (await builderApi("POST", "/api/roster", { election_id: electionId, generate_codes: n })) {
      await fetchRoster();
    }
  }
  async function removeRosterEntry(id) {
    if (await builderApi("DELETE", "/api/roster", { election_id: electionId, id })) await fetchRoster();
  }
  async function clearRoster() {
    if (!confirm("Clear the entire eligibility list?")) return;
    if (await builderApi("DELETE", "/api/roster", { election_id: electionId, all: true })) await fetchRoster();
  }

  /* ═══════════ RENDER ═══════════ */
  const status = election?.status || "waiting";
  const currentPosition = getCurrentPosition();
  const voterPath = `/${orgSlug}/${electionSlug}`;
  const canResetPolls = status === "waiting" && !election?.active_position_id;
  const selectedLaunchPosition = selectedLaunchPositionId
    ? positions.find((p) => p.id === selectedLaunchPositionId)
    : null;

  /* Pre-poll: load candidates for the selected position. */
  useEffect(() => {
    if (status !== "waiting" || !selectedLaunchPositionId) return;
    fetchCandidates(selectedLaunchPositionId);
  }, [status, selectedLaunchPositionId, fetchCandidates]);

  /* Load the ballot builder while the election is idle. */
  useEffect(() => {
    if (status === "waiting" || status === "draft") fetchBuilder();
  }, [status, fetchBuilder]);

  /* Load the eligibility list while the election is idle. */
  useEffect(() => {
    if (status === "waiting" || status === "draft") fetchRoster();
  }, [status, fetchRoster]);

  const maxVotes = Math.max(...Object.values(voteCounts), 0);
  const leaders = Object.entries(voteCounts).filter(([, c]) => c === maxVotes && maxVotes > 0).map(([id]) => id);
  const isTie = leaders.length > 1;
  const historyMaxVotes = Math.max(0, ...Object.values(historyVoteCounts));
  const historyLeaders = Object.entries(historyVoteCounts).filter(([, c]) => c === historyMaxVotes && historyMaxVotes > 0).map(([id]) => id);

  if (loadError && !election) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-uga-gray px-6">
        <p className="text-sm text-uga-gray-mid text-center">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-uga-gray">
      <header className="bg-white border-b border-gray-100 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display font-black text-lg text-uga-black truncate">
              {org?.name ? `${org.name} · Control` : "Election Control"}
            </h1>
            <p className="text-xs text-uga-gray-mid font-semibold uppercase tracking-wider">
              {election?.title}
              {status === "waiting" && " · Pre-Poll"}
              {status === "voting" && " · Live Voting"}
              {status === "locked" && " · Results"}
              {status === "completed" && " · Complete"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {status === "voting" && election?.poll_expires_at && (
              <AdminCountdown expiresAt={election.poll_expires_at} />
            )}
            <span
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
          <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider mb-3">Election Progress</h2>
          {positions.length === 0 ? (
            <p className="text-sm text-uga-gray-mid">
              No positions yet — add them in <strong>Ballot setup</strong> below.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {positions.map((p) => (
                <span
                  key={p.id}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                    p.is_completed
                      ? "bg-green-100 text-green-800"
                      : p.id === election?.active_position_id
                      ? "bg-uga-red text-white"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {p.title}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Voter link */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider mb-2">Voter link</h2>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 truncate">
              {voterPath}
            </code>
            <a
              href={voterPath}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-bold text-uga-red px-3 py-2 rounded-lg border border-uga-red/30 hover:bg-red-50 transition-colors shrink-0"
            >
              Open
            </a>
          </div>
        </section>

        {/* Ballot setup (builder) — while idle */}
        {(status === "waiting" || status === "draft") && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display font-black text-lg text-uga-black">Ballot setup</h2>
              {builderLoading && <span className="text-xs text-uga-gray-mid">Saving…</span>}
            </div>
            {builderPositions.length === 0 && (
              <p className="text-sm text-uga-gray-mid mb-3">
                Add the positions voters will choose for, then add candidates to each.
              </p>
            )}
            <div className="space-y-4">
              {builderPositions.map((p, idx) => (
                <div key={p.id} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      defaultValue={p.title}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== p.title) renamePosition(p.id, v);
                      }}
                      className="flex-1 h-9 px-2 rounded-lg border border-gray-200 font-bold text-uga-black focus:border-uga-red"
                      aria-label="Position title"
                    />
                    <button onClick={() => movePosition(p.id, "up")} disabled={idx === 0} className="h-9 w-9 rounded-lg border border-gray-200 text-uga-black disabled:opacity-30" aria-label="Move up">↑</button>
                    <button onClick={() => movePosition(p.id, "down")} disabled={idx === builderPositions.length - 1} className="h-9 w-9 rounded-lg border border-gray-200 text-uga-black disabled:opacity-30" aria-label="Move down">↓</button>
                    <button onClick={() => deletePosition(p.id, p.title)} className="text-xs font-bold text-uga-red px-2 py-2 rounded-lg border border-uga-red/30 hover:bg-red-50">Delete</button>
                  </div>
                  <div className="space-y-1 mb-2 pl-1">
                    {p.candidates.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-uga-black">
                          {c.name}
                          {!c.is_active && <span className="text-gray-400"> (inactive)</span>}
                        </span>
                        <button onClick={() => deleteBuilderCandidate(c.id, c.name)} className="text-xs font-bold text-uga-red px-2 py-0.5 rounded hover:bg-red-50 shrink-0">Remove</button>
                      </div>
                    ))}
                    {p.candidates.length === 0 && <p className="text-xs text-uga-gray-mid">No candidates yet.</p>}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={newCandidateByPos[p.id] || ""}
                      onChange={(e) => setNewCandidateByPos((m) => ({ ...m, [p.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && addBuilderCandidate(p.id)}
                      placeholder="Add candidate…"
                      className="flex-1 h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-uga-red"
                    />
                    <button onClick={() => addBuilderCandidate(p.id)} disabled={!(newCandidateByPos[p.id] || "").trim()} className="h-9 px-3 rounded-lg bg-uga-black text-white text-sm font-semibold disabled:opacity-30">Add</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <input
                value={newPositionTitle}
                onChange={(e) => setNewPositionTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPosition()}
                placeholder="New position (e.g. President)"
                className="flex-1 h-11 px-3 rounded-xl border-2 border-gray-200 focus:border-uga-red"
              />
              <button onClick={addPosition} disabled={!newPositionTitle.trim()} className="h-11 px-5 rounded-xl bg-uga-red text-white font-bold disabled:opacity-40">Add position</button>
            </div>
          </section>
        )}

        {/* Voter eligibility */}
        {(status === "waiting" || status === "draft") && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-lg text-uga-black mb-3">Voter eligibility</h2>
            <label htmlFor="elig-mode" className="block text-sm font-semibold text-uga-black mb-1">
              How voters are verified
            </label>
            <select
              id="elig-mode"
              value={election?.eligibility_mode || "pin"}
              onChange={(e) => changeEligibility(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white font-semibold focus:border-uga-red"
            >
              <option value="open">Open — anyone with the link</option>
              <option value="pin">Room PIN</option>
              <option value="roster_csv">Roster — match a list of names</option>
              <option value="email_magic_link">Email allowlist</option>
              <option value="access_code">Single-use access codes</option>
            </select>

            {election?.eligibility_mode === "open" && (
              <p className="text-sm text-uga-gray-mid mt-3">Anyone with the voter link can vote — no check-in.</p>
            )}

            {election?.eligibility_mode === "pin" && (
              <div className="mt-3 flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-uga-gray-mid mb-1">
                    Room PIN (current: <span className="font-mono text-uga-black">{election?.pin || "—"}</span>)
                  </label>
                  <input
                    value={pinDraft}
                    onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    placeholder="New PIN"
                    inputMode="numeric"
                    className="w-full h-11 px-3 rounded-lg border-2 border-gray-200 focus:border-uga-red text-center tracking-widest font-bold"
                  />
                </div>
                <button onClick={savePin} disabled={!pinDraft.trim()} className="h-11 px-4 rounded-lg bg-uga-black text-white font-semibold disabled:opacity-30">
                  Save PIN
                </button>
              </div>
            )}

            {(election?.eligibility_mode === "roster_csv" || election?.eligibility_mode === "email_magic_link") && (
              <div className="mt-4">
                <p className="text-sm text-uga-gray-mid mb-2">
                  {election.eligibility_mode === "email_magic_link"
                    ? "Paste eligible emails, one per line. Only these emails can vote."
                    : "Paste eligible names, one per line. Matching names are auto-verified; others wait for your manual verify."}
                </p>
                <textarea
                  value={rosterText}
                  onChange={(e) => setRosterText(e.target.value)}
                  rows={4}
                  placeholder={election.eligibility_mode === "email_magic_link" ? "ada@example.com\nalan@example.com" : "Ada Lovelace\nAlan Turing"}
                  className="w-full px-3 py-2 rounded-xl border-2 border-gray-200 focus:border-uga-red text-sm font-mono"
                />
                <button onClick={addRoster} disabled={!rosterText.trim()} className="mt-2 h-11 px-5 rounded-xl bg-uga-red text-white font-bold disabled:opacity-40">
                  Add to list
                </button>
                <RosterList entries={rosterEntries} onRemove={removeRosterEntry} onClear={clearRoster} showToken={false} />
              </div>
            )}

            {election?.eligibility_mode === "access_code" && (
              <div className="mt-4">
                <p className="text-sm text-uga-gray-mid mb-2">
                  Generate single-use codes and hand them out. Each code works on one device.
                </p>
                <div className="flex gap-2 items-end">
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    value={genCount}
                    onChange={(e) => setGenCount(Number(e.target.value))}
                    className="w-28 h-11 px-3 rounded-lg border-2 border-gray-200 focus:border-uga-red text-center font-bold"
                  />
                  <button onClick={generateCodes} className="h-11 px-5 rounded-xl bg-uga-red text-white font-bold">
                    Generate codes
                  </button>
                </div>
                <RosterList entries={rosterEntries} onRemove={removeRosterEntry} onClear={clearRoster} showToken={true} />
              </div>
            )}
          </section>
        )}

        {/* Pre-poll: launch */}
        {status === "waiting" && selectedLaunchPosition && incompletePositions.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-lg text-uga-black mb-4">Launch poll</h2>
            <div className="mb-4">
              <label htmlFor="launch-pos" className="text-sm font-semibold text-uga-black block mb-2">
                Position for this poll
              </label>
              <select
                id="launch-pos"
                value={selectedLaunchPositionId || ""}
                onChange={(e) => setSelectedLaunchPositionId(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-uga-black font-semibold focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
              >
                {incompletePositions.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>

            <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-3">
              Candidates — {selectedLaunchPosition.title}
            </p>
            <div className="space-y-2 mb-4">
              {candidates.map((c) => (
                <div key={c.id} className="flex items-center gap-2 min-h-[48px] px-3 py-2 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={c.is_active}
                      onChange={() => toggleCandidate(c.id, c.is_active)}
                      className="w-5 h-5 accent-uga-red rounded shrink-0"
                    />
                    <span className={`font-semibold truncate ${c.is_active ? "text-uga-black" : "text-gray-300 line-through"}`}>
                      {c.name}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => removeCandidate(c)}
                    disabled={loading}
                    className="shrink-0 text-xs font-bold text-uga-red px-3 py-2 rounded-lg border border-transparent hover:bg-red-50 hover:border-red-100 disabled:opacity-40 transition-colors"
                    aria-label={`Remove ${c.name} from ballot`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Floor nomination name…"
                value={newCandidateName}
                onChange={(e) => setNewCandidateName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCandidate()}
                className="flex-1 h-12 px-4 rounded-xl border-2 border-gray-200 bg-white focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
              />
              <button
                onClick={addCandidate}
                disabled={!newCandidateName.trim()}
                className="h-12 px-4 rounded-xl bg-uga-black text-white font-semibold enabled:hover:bg-gray-800 disabled:opacity-30 transition-all"
              >
                Add
              </button>
            </div>

            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm font-semibold text-uga-black" htmlFor="timer-dur">Timer (seconds):</label>
              <input
                id="timer-dur"
                type="number"
                min={10}
                max={300}
                value={timerDuration}
                onChange={(e) => setTimerDuration(Number(e.target.value))}
                className="w-24 h-10 px-3 rounded-lg border-2 border-gray-200 focus:border-uga-red text-center font-bold"
              />
            </div>

            <button
              onClick={launchPoll}
              disabled={loading || candidates.filter((c) => c.is_active).length === 0}
              className="w-full h-14 rounded-xl bg-uga-red text-white font-bold text-lg shadow-lg shadow-uga-red/25 enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
            >
              {loading ? "Launching…" : `Launch Poll — ${selectedLaunchPosition.title}`}
            </button>
          </section>
        )}

        {/* Locked: results + actions */}
        {status === "locked" && currentPosition && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-black text-lg text-uga-black">Results: {currentPosition.title}</h2>
              <p className="font-display font-black text-3xl text-uga-black tabular-nums">{totalVotes}</p>
            </div>
            <div className="space-y-1 mb-4">
              {candidates
                .filter((c) => c.is_active)
                .sort((a, b) => (voteCounts[b.id] || 0) - (voteCounts[a.id] || 0))
                .map((c) => (
                  <VoteBar key={c.id} name={c.name} count={voteCounts[c.id] || 0} total={totalVotes} barColor={candidateChartColorForId(c.id)} isLeader={leaders.includes(c.id)} />
                ))}
            </div>
            {isTie && (
              <div className="bg-red-50 border-2 border-uga-red rounded-xl p-3 mb-4">
                <p className="font-bold text-uga-red text-sm">⚠ Tie Detected — A runoff may be required.</p>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={clearAndRestart} disabled={loading} className="flex-1 h-12 rounded-xl bg-red-50 border-2 border-uga-red text-uga-red font-bold enabled:hover:bg-red-100 disabled:opacity-40 transition-all">
                Clear &amp; Restart
              </button>
              <button onClick={finalizePosition} disabled={loading} className="flex-1 h-12 rounded-xl bg-uga-red text-white font-bold enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all">
                Finalize position
              </button>
            </div>
          </section>
        )}

        {/* Active voting: live telemetry */}
        {status === "voting" && currentPosition && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-black text-lg text-uga-black">{currentPosition.title}</h2>
              <div className="text-right">
                <p className="text-xs text-uga-gray-mid font-semibold uppercase">Total Votes</p>
                <p className="font-display font-black text-3xl text-uga-black tabular-nums">{totalVotes}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_min(220px,100%)] gap-6 lg:gap-8 mb-6 items-start">
              <div className="space-y-1 min-w-0">
                {candidates.filter((c) => c.is_active).map((c) => (
                  <VoteBar key={c.id} name={c.name} count={voteCounts[c.id] || 0} total={totalVotes} barColor={candidateChartColorForId(c.id)} isLeader={leaders.includes(c.id)} />
                ))}
              </div>
              <VotePieChart candidates={candidates} voteCounts={voteCounts} totalVotes={totalVotes} leaderIds={leaders} />
            </div>
            <button onClick={lockPoll} disabled={loading} className="w-full h-12 rounded-xl bg-uga-black text-white font-bold enabled:hover:bg-gray-800 disabled:opacity-40 transition-all">
              Lock Early
            </button>
          </section>
        )}

        {/* Review past polls */}
        {positions.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider mb-3">Review past polls</h2>
            <label htmlFor="history-pos" className="sr-only">Position to review</label>
            <select
              id="history-pos"
              value={historyPositionId}
              onChange={(e) => setHistoryPositionId(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-uga-black font-semibold mb-4 focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
            >
              <option value="">Select a position…</option>
              {[...positions].sort((a, b) => a.sort_order - b.sort_order).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}{p.is_completed ? " (finalized)" : ""}
                </option>
              ))}
            </select>

            {historyLoading && historyPositionId && <p className="text-sm text-uga-gray-mid mb-2">Loading…</p>}

            {historyPositionId && !historyLoading && historyWinner && (
              <>
                <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-4">
                  <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-1">Winner (active ballot)</p>
                  <p className="font-display font-black text-lg text-uga-black">
                    {historyWinner.display}
                    {historyWinner.is_tie && <span className="text-amber-700 font-semibold text-base ml-2">(tie)</span>}
                  </p>
                  <p className="text-xs text-uga-gray-mid mt-2">
                    {historyWinner.is_completed ? "Finalized" : "Not finalized yet"} · {historyTotal} total {historyTotal === 1 ? "vote" : "votes"} cast
                  </p>
                </div>
                <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-2">All candidates (vote counts)</p>
                <div className="space-y-1 mb-4">
                  {[...historyCandidates]
                    .sort((a, b) => (historyVoteCounts[b.id] || 0) - (historyVoteCounts[a.id] || 0))
                    .map((c) => (
                      <VoteBar key={c.id} name={c.is_active ? c.name : `${c.name} (inactive)`} count={historyVoteCounts[c.id] || 0} total={Math.max(historyTotal, 1)} barColor={candidateChartColorForId(c.id)} isLeader={historyLeaders.includes(c.id)} />
                    ))}
                </div>
                <button
                  type="button"
                  onClick={resetHistoryPosition}
                  disabled={loading || !canResetPolls}
                  title={!canResetPolls ? "Finish or finalize the current poll first." : undefined}
                  className="w-full h-12 rounded-xl border-2 border-uga-red text-uga-red font-bold enabled:hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Reset this poll
                </button>
                {!canResetPolls && (
                  <p className="text-xs text-uga-gray-mid mt-2 text-center">Reset is available when the room is waiting (no active or locked poll).</p>
                )}
              </>
            )}

            {historyPositionId && !historyLoading && !historyWinner && (
              <p className="text-sm text-uga-gray-mid">Could not load results for this position.</p>
            )}

            <div className="mt-6 pt-4 border-t border-gray-100">
              <button type="button" onClick={resetAllResults} disabled={loading} className="w-full h-11 rounded-xl bg-uga-black text-white font-semibold text-sm enabled:hover:bg-gray-800 disabled:opacity-40 transition-all">
                Reset entire election
              </button>
              <p className="text-xs text-uga-gray-mid text-center mt-2">Removes all votes and un-finalizes every position. Voter devices clear saved votes.</p>
            </div>
          </section>
        )}

        {/* All positions complete: winner list */}
        {(status === "waiting" || status === "completed") && incompletePositions.length === 0 && positions.length > 0 && (
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-xl text-uga-black mb-1 text-center">Election complete</h2>
            <p className="text-uga-gray-mid text-sm text-center mb-6">
              All {positions.length} positions finalized — plurality winner per position (ties noted).
            </p>
            {finalResultsError && <p className="text-uga-red text-sm text-center font-medium mb-4">{finalResultsError}</p>}
            <ul className="space-y-3">
              {finalWinners.map((w) => (
                <li key={w.position_id} className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 pb-3 border-b border-gray-100 last:border-0 last:pb-0">
                  <span className="text-sm font-bold text-uga-black shrink-0">{w.title}</span>
                  <span className="text-sm text-uga-gray-mid sm:text-right">
                    <span className="font-semibold text-uga-black">{w.display}</span>
                    {w.is_tie && <span className="ml-2 text-amber-700 font-semibold">(tie)</span>}
                    {w.vote_count > 0 && (
                      <span className="text-uga-gray-mid font-normal ml-1 tabular-nums">· {w.vote_count} {w.vote_count === 1 ? "vote" : "votes"}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {finalWinners.length === 0 && !finalResultsError && <p className="text-uga-gray-mid text-sm text-center">Loading results…</p>}
            <button type="button" onClick={resetAllResults} disabled={loading} className="w-full mt-8 h-12 rounded-xl border-2 border-gray-300 text-uga-black font-bold enabled:hover:bg-gray-50 disabled:opacity-40 transition-all">
              Reset entire election
            </button>
          </section>
        )}

        {/* Member check-in */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider">Voter check-in</h2>
            <button type="button" onClick={() => fetchCheckins()} disabled={checkinsLoading} className="text-xs font-bold text-uga-red px-3 py-1.5 rounded-lg border border-uga-red/30 hover:bg-red-50 disabled:opacity-40 transition-colors">
              {checkinsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {checkinsError && <p className="text-uga-red text-sm font-medium mb-2">{checkinsError}</p>}
          {!checkinsLoading && !checkinsError && memberCheckins.length === 0 && (
            <p className="text-sm text-uga-gray-mid">No one has checked in yet.</p>
          )}
          {memberCheckins.length > 0 && (
            <>
              <p className="text-xs font-bold text-uga-black mb-2 tabular-nums">
                {memberCheckins.length} checked in
                {checkinStats.unverified > 0 && <span className="ml-2 font-semibold text-amber-800">· {checkinStats.unverified} unverified</span>}
                {checkinStats.duplicateNames > 0 && <span className="ml-2 font-semibold text-violet-900">· {checkinStats.duplicateNames} duplicate name{checkinStats.duplicateNames === 1 ? "" : "s"}</span>}
              </p>
              <ul className="max-h-56 overflow-y-auto space-y-1.5 border border-gray-100 rounded-xl p-3 bg-gray-50/50">
                {memberCheckins.map((row) => (
                  <li
                    key={row.device_hash}
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
                      <span className="font-medium text-uga-black truncate">{row.display_name}</span>
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
                      <span className="text-xs text-uga-gray-mid tabular-nums">
                        {row.updated_at ? new Date(row.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
                      </span>
                      {!row.verified && (
                        <button
                          type="button"
                          onClick={() => verifyCheckin(row.device_hash, row.display_name)}
                          disabled={checkinVerifyingHash === row.device_hash || checkinRemovingHash === row.device_hash}
                          className="text-xs font-bold text-green-800 px-2 py-1 rounded-md border border-green-700/35 hover:bg-green-50 disabled:opacity-40 transition-colors"
                        >
                          {checkinVerifyingHash === row.device_hash ? "…" : "Verify"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeCheckin(row.device_hash, row.display_name)}
                        disabled={checkinRemovingHash === row.device_hash || checkinVerifyingHash === row.device_hash}
                        className="text-xs font-bold text-uga-red px-2 py-1 rounded-md border border-uga-red/40 hover:bg-red-50 disabled:opacity-40 transition-colors"
                      >
                        {checkinRemovingHash === row.device_hash ? "…" : "Remove"}
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

  const loadElections = useCallback(async (slug) => {
    if (!slug) return;
    setElections(null);
    const res = await fetch(`/api/elections?org=${encodeURIComponent(slug)}`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    const list = data.elections || [];
    setElections(list);
    setElectionSlug((prev) => {
      if (prev && list.some((e) => e.slug === prev)) return prev;
      if (list.some((e) => e.slug === target.election)) return target.election;
      return list[0]?.slug || "";
    });
    setCreatingElection(list.length === 0);
  }, [target.election]);

  useEffect(() => {
    if (orgSlug) loadElections(orgSlug);
  }, [orgSlug, loadElections]);

  if (orgs.length === 0) {
    return (
      <div className="min-h-dvh bg-uga-gray py-10 px-4">
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

  return (
    <div className="min-h-dvh bg-uga-gray">
      <TopBar
        me={me}
        onLogout={onLogout}
        orgs={orgs}
        orgSlug={orgSlug}
        onOrgChange={setOrgSlug}
        elections={elections || []}
        electionSlug={electionSlug}
        onElectionChange={(v) => {
          if (v === "__new__") setCreatingElection(true);
          else {
            setCreatingElection(false);
            setElectionSlug(v);
          }
        }}
      />
      {creatingElection || (elections && elections.length === 0) ? (
        <div className="py-10 px-4">
          <CreateElection
            orgSlug={orgSlug}
            onCreated={async (el) => {
              setCreatingElection(false);
              await loadElections(orgSlug);
              setElectionSlug(el.slug);
            }}
          />
        </div>
      ) : elections === null ? (
        <div className="py-20 text-center text-sm text-uga-gray-mid">Loading…</div>
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
        <div className="flex items-center gap-2 flex-wrap">
          {orgs && orgs.length > 0 && (
            <select
              value={orgSlug}
              onChange={(e) => onOrgChange(e.target.value)}
              className="h-9 px-2 rounded-lg border border-gray-200 bg-white text-sm font-semibold"
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
              className="h-9 px-2 rounded-lg border border-gray-200 bg-white text-sm font-semibold"
              aria-label="Election"
            >
              {elections.map((e) => (
                <option key={e.id} value={e.slug}>{e.title}</option>
              ))}
              <option value="__new__">＋ New election…</option>
            </select>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-uga-gray-mid truncate max-w-[160px]">{me.user.email}</span>
          <button onClick={onLogout} className="text-xs font-bold text-uga-red px-2.5 py-1 rounded-lg border border-uga-red/30 hover:bg-red-50 transition-colors">
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
      const res = await fetch("/api/auth/me", { credentials: "include" });
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
      <div className="min-h-dvh flex items-center justify-center bg-uga-gray">
        <p className="text-sm text-uga-gray-mid">Loading…</p>
      </div>
    );
  }
  if (!me.user) return <AuthScreen onAuthed={reloadMe} />;
  return <Workspace me={me} reloadMe={reloadMe} onLogout={onLogout} />;
}
