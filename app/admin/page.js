"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getSupabaseBrowser } from "../../lib/supabase";
import { NSBE_LOGO_ALT, NSBE_LOGO_SRC } from "../../lib/branding";
import { sortCandidatesByLastName } from "../../lib/candidates-sort";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN LOGIN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function AdminLogin({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "auth", password }),
      });
      if (res.ok) {
        onLogin();
      } else if (res.status === 429) {
        setError("Too many attempts. Try again in a moment.");
      } else {
        setError("Invalid password.");
      }
    } catch {
      setError("Network error. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-6 bg-uga-gray">
      <div className="w-full max-w-sm">
        <img
          src={NSBE_LOGO_SRC}
          alt={NSBE_LOGO_ALT}
          className="h-24 w-auto max-w-[min(100%,200px)] mx-auto mb-5 object-contain drop-shadow-sm"
          width={180}
          height={188}
        />
        <h1 className="font-display font-black text-2xl text-center mb-6">
          Admin Dashboard
        </h1>
        <input
          type="password"
          placeholder="Admin Password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          className="w-full h-14 px-4 rounded-xl border-2 border-gray-200 bg-white text-lg
                     focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
          autoFocus
        />
        {error && <p className="text-uga-red text-sm mt-2 font-medium">{error}</p>}
        <button
          onClick={handleLogin}
          disabled={!password || busy}
          className="w-full mt-4 h-14 rounded-xl bg-uga-red text-white font-bold text-lg
                     enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
        >
          {busy ? "Signing in…" : "Log In"}
        </button>
      </div>
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   VOTE BAR CHART
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
/** Distinct hues for bars / pie slices; stable per candidate via id hash. */
const CANDIDATE_CHART_COLORS = [
  "#BA0C2F",
  "#1D4ED8",
  "#047857",
  "#B45309",
  "#7C3AED",
  "#BE185D",
  "#0D9488",
  "#CA8A04",
  "#4338CA",
  "#C2410C",
  "#0369A1",
  "#15803D",
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
      <span className="w-10 text-right tabular-nums text-sm font-bold text-uga-black">
        {count}
      </span>
    </div>
  );
}

/** SVG pie chart for live vote share (slice colors match VoteBar per candidate id). */
function VotePieChart({ candidates, voteCounts, totalVotes, leaderIds }) {
  const active = candidates.filter((c) => c.is_active);
  const cx = 100;
  const cy = 100;
  const r = 88;

  const segments = active.map((c) => {
    const count = voteCounts[c.id] || 0;
    const isLeader = leaderIds.includes(c.id);
    const color = candidateChartColorForId(c.id);
    return { id: c.id, name: c.name, count, color, isLeader };
  });

  const label = segments
    .filter((s) => s.count > 0)
    .map((s) => `${s.name}: ${s.count}`)
    .join(", ");

  if (totalVotes === 0) {
    return (
      <figure className="flex flex-col items-center">
        <svg viewBox="0 0 200 200" className="w-44 h-44 max-w-full shrink-0" role="img" aria-label="No votes yet">
          <circle cx={cx} cy={cy} r={r} fill="#F3F4F6" stroke="#E5E7EB" strokeWidth="2" />
          <text
            x={cx}
            y={cy + 5}
            textAnchor="middle"
            fill="#9CA3AF"
            fontSize="11"
            fontWeight="600"
            fontFamily="system-ui, sans-serif"
          >
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
        <circle
          key={s.id}
          cx={cx}
          cy={cy}
          r={r}
          fill={s.color}
          stroke={s.isLeader ? "#111827" : "#fff"}
          strokeWidth={s.isLeader ? 2.5 : 1}
        />
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
      <path
        key={s.id}
        d={d}
        fill={s.color}
        stroke={s.isLeader ? "#111827" : "#fff"}
        strokeWidth={s.isLeader ? 2.5 : 1}
      />
    );
    angle = endAngle;
  }

  return (
    <figure className="flex flex-col items-center w-full max-w-[220px] mx-auto md:mx-0">
      <svg
        viewBox="0 0 200 200"
        className="w-44 h-44 max-w-full shrink-0 drop-shadow-sm rounded-full"
        role="img"
        aria-label={label ? `Vote share: ${label}` : "Vote share"}
      >
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   COUNTDOWN (admin version)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN DASHBOARD
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function Dashboard({ onSessionExpired }) {
  const [roles, setRoles] = useState([]);
  const [electionState, setElectionState] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [voteCounts, setVoteCounts] = useState({});
  const [totalVotes, setTotalVotes] = useState(0);
  const [newCandidateName, setNewCandidateName] = useState("");
  const [timerDuration, setTimerDuration] = useState(60);
  const [loading, setLoading] = useState(false);
  /** Which incomplete role to prep / launch next (admin choice, not fixed slate order). */
  const [selectedLaunchRoleId, setSelectedLaunchRoleId] = useState(null);
  const [finalWinners, setFinalWinners] = useState([]);
  const [finalResultsError, setFinalResultsError] = useState(null);
  const [historyRoleId, setHistoryRoleId] = useState("");
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

  const supabase = useRef(null);
  const pollInterval = useRef(null);

  // Cookie-based auth: send credentials, JSON only in headers.
  const jsonHeaders = { "Content-Type": "application/json" };
  const fetchOpts = { credentials: "include" };

  /* ── Fetch all roles ── */
  const fetchRoles = useCallback(async () => {
    const { data } = await supabase.current
      .from("roles")
      .select("*")
      .order("sort_order");
    setRoles(data || []);
  }, []);

  /* ── Fetch election state ── */
  const fetchState = useCallback(async () => {
    const { data } = await supabase.current
      .from("election_state")
      .select("*")
      .single();
    setElectionState(data);
    return data;
  }, []);

  /* ── Fetch candidates for active role ── */
  const fetchCandidates = useCallback(async (roleId) => {
    if (!roleId) { setCandidates([]); return; }
    const { data } = await supabase.current
      .from("candidates")
      .select("*")
      .eq("role_id", roleId);
    setCandidates(sortCandidatesByLastName(data || []));
  }, []);

  /* ── Fetch vote counts (admin has SELECT on votes via service key) ── */
  const fetchVotes = useCallback(async (roleId) => {
    if (!roleId) { setVoteCounts({}); setTotalVotes(0); return; }
    try {
      const res = await fetch(`/api/vote?role_id=${encodeURIComponent(roleId)}`, fetchOpts);
      if (res.status === 401) { onSessionExpired(); return; }
      if (res.ok) {
        const data = await res.json();
        setVoteCounts(data.counts || {});
        setTotalVotes(data.total || 0);
      }
    } catch {
      // network blip; next poll will retry
    }
  }, []);

  const fetchFinalResults = useCallback(async () => {
    try {
      const res = await fetch("/api/results", fetchOpts);
      if (res.status === 401) { onSessionExpired(); return; }
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
  }, []);

  const fetchCheckins = useCallback(async () => {
    setCheckinsLoading(true);
    setCheckinsError(null);
    try {
      const res = await fetch("/api/checkin", fetchOpts);
      if (res.status === 401) { onSessionExpired(); return; }
      const data = await res.json();
      if (!res.ok) {
        setCheckinsError(data.error || "Could not load member check-ins.");
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
  }, []);

  const checkinDuesStats = useMemo(() => {
    let onRoster = 0;
    let flagged = 0;
    let duplicateNames = 0;
    for (const row of memberCheckins) {
      if (row.dues_ok) onRoster += 1;
      else flagged += 1;
      if (row.name_duplicate) duplicateNames += 1;
    }
    return { onRoster, flagged, duplicateNames };
  }, [memberCheckins]);

  const removeCheckin = useCallback(
    async (deviceHash, displayName) => {
      if (
        !confirm(
          `Remove "${displayName}" from check-in? Their device will need to join again with a valid name.`
        )
      ) {
        return;
      }
      setCheckinRemovingHash(deviceHash);
      try {
        const res = await fetch("/api/checkin", {
          method: "DELETE",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ device_hash: deviceHash }),
        });
        if (res.status === 401) { onSessionExpired(); return; }
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
    [fetchCheckins]
  );

  const verifyCheckinDues = useCallback(
    async (deviceHash, displayName) => {
      if (
        !confirm(
          `Confirm that "${displayName}" is a dues-paying member? This clears the roster flag for this check-in.`
        )
      ) {
        return;
      }
      setCheckinVerifyingHash(deviceHash);
      try {
        const res = await fetch("/api/checkin", {
          method: "PATCH",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ device_hash: deviceHash, verify_dues: true }),
        });
        if (res.status === 401) { onSessionExpired(); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || "Could not save verification.");
          return;
        }
        await fetchCheckins();
      } catch {
        alert("Network error confirming dues.");
      } finally {
        setCheckinVerifyingHash(null);
      }
    },
    [fetchCheckins]
  );

  const loadHistoryRole = useCallback(
    async (roleId) => {
      if (!roleId) {
        setHistoryCandidates([]);
        setHistoryVoteCounts({});
        setHistoryTotal(0);
        setHistoryWinner(null);
        return;
      }
      setHistoryLoading(true);
      try {
        const { data: cands } = await supabase.current
          .from("candidates")
          .select("*")
          .eq("role_id", roleId);
        setHistoryCandidates(sortCandidatesByLastName(cands || []));

        try {
          const vr = await fetch(`/api/vote?role_id=${encodeURIComponent(roleId)}`, fetchOpts);
          if (vr.status === 401) { onSessionExpired(); return; }
          if (vr.ok) {
            const j = await vr.json();
            setHistoryVoteCounts(j.counts || {});
            setHistoryTotal(j.total || 0);
          } else {
            setHistoryVoteCounts({});
            setHistoryTotal(0);
          }

          const wr = await fetch(
            `/api/results?role_id=${encodeURIComponent(roleId)}`,
            fetchOpts
          );
          if (wr.status === 401) { onSessionExpired(); return; }
          if (wr.ok) {
            const j = await wr.json();
            setHistoryWinner(j.winner ?? null);
          } else {
            setHistoryWinner(null);
          }
        } catch {
          setHistoryVoteCounts({});
          setHistoryTotal(0);
          setHistoryWinner(null);
        }
      } finally {
        setHistoryLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    loadHistoryRole(historyRoleId || "");
  }, [historyRoleId, loadHistoryRole]);

  const incompleteRoles = roles
    .filter((r) => !r.is_completed)
    .sort((a, b) => a.sort_order - b.sort_order);

  /* ── Keep launch selection valid when roles / completion changes ── */
  useEffect(() => {
    const incomplete = roles
      .filter((r) => !r.is_completed)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (incomplete.length === 0) {
      setSelectedLaunchRoleId(null);
      return;
    }
    setSelectedLaunchRoleId((prev) => {
      if (prev && incomplete.some((r) => r.id === prev)) return prev;
      return incomplete[0].id;
    });
  }, [roles]);

  const electionFullyDone =
    roles.length > 0 && roles.every((r) => r.is_completed);

  useEffect(() => {
    if (electionState?.status !== "waiting" || !electionFullyDone) {
      setFinalWinners([]);
      setFinalResultsError(null);
      return;
    }
    fetchFinalResults();
  }, [electionState?.status, electionFullyDone, fetchFinalResults]);

  function getCurrentRole() {
    if (!electionState?.active_role_id) return null;
    return roles.find((r) => r.id === electionState.active_role_id) || null;
  }

  /* ── Initialize ── */
  useEffect(() => {
    supabase.current = getSupabaseBrowser();
    fetchRoles().then(() => fetchState());
    fetchCheckins();
  }, [fetchRoles, fetchState, fetchCheckins]);

  /* ── Load candidates & votes when state changes ── */
  useEffect(() => {
    if (!electionState?.active_role_id) return;
    fetchCandidates(electionState.active_role_id);
    fetchVotes(electionState.active_role_id);
  }, [electionState?.active_role_id, fetchCandidates, fetchVotes]);

  /* ── Poll vote counts every 2s during active voting ── */
  useEffect(() => {
    if (electionState?.status === "voting" && electionState?.active_role_id) {
      pollInterval.current = setInterval(() => {
        fetchVotes(electionState.active_role_id);
      }, 2000);
    }
    return () => clearInterval(pollInterval.current);
  }, [electionState?.status, electionState?.active_role_id, fetchVotes]);

  /* ── Auto-lock when timer expires ── */
  const autoLockFired = useRef(false);
  useEffect(() => {
    if (electionState?.status !== "voting" || !electionState?.poll_expires_at) {
      autoLockFired.current = false;
      return;
    }
    const target = new Date(electionState.poll_expires_at).getTime();
    function check() {
      if (Date.now() >= target && !autoLockFired.current) {
        autoLockFired.current = true;
        fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action: "lock" }),
        })
          .then(() => {
            fetchState();
            fetchVotes(electionState.active_role_id);
          })
          .catch(() => {
            // F13: retry on next tick if network hiccup
            autoLockFired.current = false;
          });
      }
    }
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [electionState?.status, electionState?.poll_expires_at]);

  /* ── API helpers ── */
  async function apiCall(action, body = {}) {
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action, ...body }),
        });
      } catch {
        // F12: surface network failures instead of silently advancing state
        alert("Network error — check your connection and try again.");
        return;
      }
      if (res.status === 401) { onSessionExpired(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) alert(data.error || "Action failed");
      await fetchState();
      await fetchRoles();
    } finally {
      setLoading(false);
    }
  }

  /* ── Launch poll ── */
  async function launchPoll() {
    if (!selectedLaunchRoleId) return;
    const chosen = roles.find((r) => r.id === selectedLaunchRoleId);
    if (!chosen || chosen.is_completed) return;
    await apiCall("launch", { role_id: selectedLaunchRoleId, duration: timerDuration });
  }

  /* ── Lock poll early ── */
  async function lockPoll() {
    await apiCall("lock");
  }

  /* ── Finalize role (mark complete, advance) ── */
  async function finalizeRole() {
    await apiCall("finalize");
    setCandidates([]);
    setVoteCounts({});
    setTotalVotes(0);
  }

  /* ── Clear votes & restart (tie-breaker — PRD §2.3) ── */
  async function clearAndRestart() {
    if (!confirm("This will DELETE all votes for this role and reopen voting. Are you sure?")) return;
    await apiCall("clear_restart", { duration: timerDuration });
  }

  /* ── Toggle candidate active status ── */
  async function toggleCandidate(candidateId, currentActive) {
    try {
      const res = await fetch("/api/candidates", {
        method: "PATCH",
        headers: jsonHeaders,
        credentials: "include",
        body: JSON.stringify({ id: candidateId, is_active: !currentActive }),
      });
      if (res.status === 401) { onSessionExpired(); return; }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Could not update candidate.");
        return;
      }
    } catch {
      alert("Network error updating candidate.");
      return;
    }
    if (electionState?.active_role_id) {
      await fetchCandidates(electionState.active_role_id);
    } else {
      const rid = selectedLaunchRoleId || incompleteRoles[0]?.id;
      if (rid) await fetchCandidates(rid);
    }
  }

  /* ── Add write-in candidate (PRD §2.3) ── */
  async function addCandidate() {
    const roleId = electionState?.active_role_id || selectedLaunchRoleId;
    const name = newCandidateName.trim();
    if (!roleId || !name) return;
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: jsonHeaders,
        credentials: "include",
        body: JSON.stringify({ role_id: roleId, name }),
      });
      if (res.status === 401) { onSessionExpired(); return; }
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
    await fetchCandidates(roleId);
  }

  /* ── Permanently remove candidate from this race ── */
  async function removeCandidate(c) {
    if (
      !confirm(
        `Remove "${c.name}" from this office permanently? They will disappear from the ballot. Any votes already cast for this person will be deleted.`
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch("/api/candidates", {
          method: "DELETE",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ id: c.id }),
        });
      } catch {
        alert("Network error removing candidate.");
        return;
      }
      if (res.status === 401) { onSessionExpired(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Could not remove candidate");
        return;
      }
      const roleId = selectedLaunchRoleId;
      if (roleId) await fetchCandidates(roleId);
    } finally {
      setLoading(false);
    }
  }

  async function resetHistoryRole() {
    if (!historyRoleId) return;
    if (electionState?.status !== "waiting" || electionState?.active_role_id) {
      alert("Finish or finalize the current poll first.");
      return;
    }
    if (
      !confirm(
        "Clear all votes for this office and mark it as not finalized? You can run this poll again later."
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action: "reset_role", role_id: historyRoleId }),
        });
      } catch {
        alert("Network error.");
        return;
      }
      if (res.status === 401) { onSessionExpired(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Reset failed");
        return;
      }
      await fetchState();
      await fetchRoles();
      await loadHistoryRole(historyRoleId);
      await fetchFinalResults();
    } finally {
      setLoading(false);
    }
  }

  async function resetAllResults() {
    if (
      !confirm(
        "Delete ALL votes everywhere, reopen every office, and return the room to waiting? Voter phones will clear their vote history for this election. This cannot be undone."
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch("/api/state", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({ action: "reset_all_results" }),
        });
      } catch {
        alert("Network error.");
        return;
      }
      if (res.status === 401) { onSessionExpired(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Reset failed");
        return;
      }
      await fetchState();
      await fetchRoles();
      await fetchFinalResults();
      await loadHistoryRole(historyRoleId || "");
    } finally {
      setLoading(false);
    }
  }

  /* ── Seed database ── */
  async function seedDatabase() {
    if (!confirm("This will reset all data and seed the election slate. Continue?")) return;
    setLoading(true);
    try {
      let res;
      try {
        res = await fetch("/api/seed", {
          method: "POST",
          headers: jsonHeaders,
          credentials: "include",
          body: JSON.stringify({}),
        });
      } catch {
        alert("Network error seeding database.");
        return;
      }
      if (res.status === 401) { onSessionExpired(); return; }
      if (res.ok) {
        alert("Database seeded successfully!");
        await fetchRoles();
        await fetchState();
      } else {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Seed failed.");
      }
    } finally {
      setLoading(false);
    }
  }

  /* ═══════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════ */

  const status = electionState?.status || "waiting";
  const currentRole = getCurrentRole();
  const canResetPolls = status === "waiting" && !electionState?.active_role_id;
  const selectedLaunchRole = selectedLaunchRoleId
    ? roles.find((r) => r.id === selectedLaunchRoleId)
    : null;

  // Pre-poll: load candidates for whichever role the admin selected
  useEffect(() => {
    if (status !== "waiting" || !selectedLaunchRoleId) return;
    fetchCandidates(selectedLaunchRoleId);
  }, [status, selectedLaunchRoleId, fetchCandidates]);

  // Determine leader for vote bars
  const maxVotes = Math.max(...Object.values(voteCounts), 0);
  const leaders = Object.entries(voteCounts)
    .filter(([, c]) => c === maxVotes && maxVotes > 0)
    .map(([id]) => id);
  const isTie = leaders.length > 1;

  const historyMaxVotes = Math.max(0, ...Object.values(historyVoteCounts));
  const historyLeaders = Object.entries(historyVoteCounts)
    .filter(([, c]) => c === historyMaxVotes && historyMaxVotes > 0)
    .map(([id]) => id);

  return (
    <div className="min-h-dvh bg-uga-gray">
      {/* Top bar */}
      <header className="bg-white border-b border-gray-100 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={NSBE_LOGO_SRC}
              alt=""
              className="h-10 w-auto shrink-0 object-contain"
              width={76}
              height={79}
            />
            <div className="min-w-0">
              <h1 className="font-display font-black text-lg text-uga-black truncate">
                Election Control
              </h1>
              <p className="text-xs text-uga-gray-mid font-semibold uppercase tracking-wider">
                {status === "waiting" && "Pre-Poll"}
                {status === "voting" && "Live Voting"}
                {status === "locked" && "Results"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {status === "voting" && electionState?.poll_expires_at && (
              <AdminCountdown expiresAt={electionState.poll_expires_at} />
            )}
            <span
              className={`inline-block w-3 h-3 rounded-full ${
                status === "voting"
                  ? "bg-green-500 animate-pulse"
                  : status === "locked"
                  ? "bg-gray-400"
                  : "bg-yellow-400"
              }`}
            />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* ── ROLE PROGRESS ── */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider mb-3">
            Election Progress
          </h2>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <span
                key={r.id}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full ${
                  r.is_completed
                    ? "bg-green-100 text-green-800"
                    : r.id === electionState?.active_role_id
                    ? "bg-uga-red text-white"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {r.title}
              </span>
            ))}
          </div>
        </section>

        {/* ── PRE-POLL: Candidate Checklist (PRD §7.1) ── */}
        {status === "waiting" && selectedLaunchRole && incompleteRoles.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-lg text-uga-black mb-4">
              Launch poll
            </h2>

            <div className="mb-4">
              <label
                htmlFor="launch-role"
                className="text-sm font-semibold text-uga-black block mb-2"
              >
                Role for this poll
              </label>
              <select
                id="launch-role"
                value={selectedLaunchRoleId || ""}
                onChange={(e) => setSelectedLaunchRoleId(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-uga-black font-semibold
                           focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
              >
                {incompleteRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>

            <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-3">
              Candidates — {selectedLaunchRole.title}
            </p>

            {/* Candidate toggles + remove */}
            <div className="space-y-2 mb-4">
              {candidates.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 min-h-[48px] px-3 py-2 rounded-xl
                             border border-gray-100 hover:bg-gray-50 transition-colors"
                >
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
                    className="shrink-0 text-xs font-bold text-uga-red px-3 py-2 rounded-lg border border-transparent
                               hover:bg-red-50 hover:border-red-100 disabled:opacity-40 transition-colors"
                    aria-label={`Remove ${c.name} from ballot`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            {/* Write-in input (PRD §2.3) */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Floor nomination name…"
                value={newCandidateName}
                onChange={(e) => setNewCandidateName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCandidate()}
                className="flex-1 h-12 px-4 rounded-xl border-2 border-gray-200 bg-white
                           focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
              />
              <button
                onClick={addCandidate}
                disabled={!newCandidateName.trim()}
                className="h-12 px-4 rounded-xl bg-uga-black text-white font-semibold
                           enabled:hover:bg-gray-800 disabled:opacity-30 transition-all"
              >
                Add
              </button>
            </div>

            {/* Timer setting */}
            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm font-semibold text-uga-black" htmlFor="timer-dur">
                Timer (seconds):
              </label>
              <input
                id="timer-dur"
                type="number"
                min={10}
                max={300}
                value={timerDuration}
                onChange={(e) => setTimerDuration(Number(e.target.value))}
                className="w-24 h-10 px-3 rounded-lg border-2 border-gray-200
                           focus:border-uga-red text-center font-bold"
              />
            </div>

            {/* Launch button */}
            <button
              onClick={launchPoll}
              disabled={loading || candidates.filter((c) => c.is_active).length === 0}
              className="w-full h-14 rounded-xl bg-uga-red text-white font-bold text-lg
                         shadow-lg shadow-uga-red/25
                         enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
            >
              {loading ? "Launching…" : `Launch Poll — ${selectedLaunchRole.title}`}
            </button>
          </section>
        )}

        {/* ── LOCKED: Results + Actions ── */}
        {status === "locked" && currentRole && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-black text-lg text-uga-black">
                Results: {currentRole.title}
              </h2>
              <p className="font-display font-black text-3xl text-uga-black tabular-nums">
                {totalVotes}
              </p>
            </div>

            {/* Final vote bars */}
            <div className="space-y-1 mb-4">
              {candidates
                .filter((c) => c.is_active)
                .sort((a, b) => (voteCounts[b.id] || 0) - (voteCounts[a.id] || 0))
                .map((c) => (
                  <VoteBar
                    key={c.id}
                    name={c.name}
                    count={voteCounts[c.id] || 0}
                    total={totalVotes}
                    barColor={candidateChartColorForId(c.id)}
                    isLeader={leaders.includes(c.id)}
                  />
                ))}
            </div>

            {/* Tie warning */}
            {isTie && (
              <div className="bg-red-50 border-2 border-uga-red rounded-xl p-3 mb-4">
                <p className="font-bold text-uga-red text-sm">
                  ⚠ Tie Detected — A runoff may be required.
                </p>
              </div>
            )}

            <div className="flex gap-2">
              {/* Clear & restart (PRD §2.3) */}
              <button
                onClick={clearAndRestart}
                disabled={loading}
                className="flex-1 h-12 rounded-xl bg-red-50 border-2 border-uga-red text-uga-red font-bold
                           enabled:hover:bg-red-100 disabled:opacity-40 transition-all"
              >
                Clear &amp; Restart
              </button>

              {/* Finalize — then pick next role from dropdown on waiting screen */}
              <button
                onClick={finalizeRole}
                disabled={loading}
                className="flex-1 h-12 rounded-xl bg-uga-red text-white font-bold
                           enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
              >
                Finalize role
              </button>
            </div>
          </section>
        )}

        {/* ── ACTIVE VOTING: Live Telemetry (PRD §7.1) ── */}
        {status === "voting" && currentRole && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-black text-lg text-uga-black">
                {currentRole.title}
              </h2>
              <div className="text-right">
                <p className="text-xs text-uga-gray-mid font-semibold uppercase">Total Votes</p>
                <p className="font-display font-black text-3xl text-uga-black tabular-nums">
                  {totalVotes}
                </p>
              </div>
            </div>

            {/* Vote distribution: bars + pie (live) */}
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_min(220px,100%)] gap-6 lg:gap-8 mb-6 items-start">
              <div className="space-y-1 min-w-0">
                {candidates
                  .filter((c) => c.is_active)
                  .map((c) => (
                    <VoteBar
                      key={c.id}
                      name={c.name}
                      count={voteCounts[c.id] || 0}
                      total={totalVotes}
                      barColor={candidateChartColorForId(c.id)}
                      isLeader={leaders.includes(c.id)}
                    />
                  ))}
              </div>
              <VotePieChart
                candidates={candidates}
                voteCounts={voteCounts}
                totalVotes={totalVotes}
                leaderIds={leaders}
              />
            </div>

            {/* Lock early button (PRD §7.2) */}
            <button
              onClick={lockPoll}
              disabled={loading}
              className="w-full h-12 rounded-xl bg-uga-black text-white font-bold
                         enabled:hover:bg-gray-800 disabled:opacity-40 transition-all"
            >
              Lock Early
            </button>
          </section>
        )}

        {/* ── Review any poll (results + winner + per-role reset) ── */}
        {roles.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider mb-3">
              Review past polls
            </h2>
            <label htmlFor="history-role" className="sr-only">
              Office to review
            </label>
            <select
              id="history-role"
              value={historyRoleId}
              onChange={(e) => setHistoryRoleId(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border-2 border-gray-200 bg-white text-uga-black font-semibold mb-4
                         focus:border-uga-red focus:ring-2 focus:ring-uga-red/20"
            >
              <option value="">Select an office…</option>
              {[...roles]
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {r.is_completed ? " (finalized)" : ""}
                  </option>
                ))}
            </select>

            {historyLoading && historyRoleId && (
              <p className="text-sm text-uga-gray-mid mb-2">Loading…</p>
            )}

            {historyRoleId && !historyLoading && historyWinner && (
              <>
                <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-4">
                  <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-1">
                    Winner (active ballot)
                  </p>
                  <p className="font-display font-black text-lg text-uga-black">
                    {historyWinner.display}
                    {historyWinner.is_tie && (
                      <span className="text-amber-700 font-semibold text-base ml-2">(tie)</span>
                    )}
                  </p>
                  <p className="text-xs text-uga-gray-mid mt-2">
                    {historyWinner.is_completed ? "Finalized" : "Not finalized yet"} ·{" "}
                    {historyTotal} total {historyTotal === 1 ? "vote" : "votes"} cast
                  </p>
                </div>
                <p className="text-xs font-bold text-uga-gray-mid uppercase tracking-wider mb-2">
                  All candidates (vote counts)
                </p>
                <div className="space-y-1 mb-4">
                  {[...historyCandidates]
                    .sort(
                      (a, b) =>
                        (historyVoteCounts[b.id] || 0) - (historyVoteCounts[a.id] || 0)
                    )
                    .map((c) => (
                      <VoteBar
                        key={c.id}
                        name={c.is_active ? c.name : `${c.name} (inactive)`}
                        count={historyVoteCounts[c.id] || 0}
                        total={Math.max(historyTotal, 1)}
                        barColor={candidateChartColorForId(c.id)}
                        isLeader={historyLeaders.includes(c.id)}
                      />
                    ))}
                </div>
                <button
                  type="button"
                  onClick={resetHistoryRole}
                  disabled={loading || !canResetPolls}
                  title={
                    !canResetPolls
                      ? "Finish or finalize the current poll first."
                      : undefined
                  }
                  className="w-full h-12 rounded-xl border-2 border-uga-red text-uga-red font-bold
                             enabled:hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Reset this poll
                </button>
                {!canResetPolls && (
                  <p className="text-xs text-uga-gray-mid mt-2 text-center">
                    Reset is available when the room is waiting (no active or locked poll).
                  </p>
                )}
              </>
            )}

            {historyRoleId && !historyLoading && !historyWinner && (
              <p className="text-sm text-uga-gray-mid">Could not load results for this office.</p>
            )}

            <div className="mt-6 pt-4 border-t border-gray-100">
              <button
                type="button"
                onClick={resetAllResults}
                disabled={loading}
                className="w-full h-11 rounded-xl bg-uga-black text-white font-semibold text-sm
                           enabled:hover:bg-gray-800 disabled:opacity-40 transition-all"
              >
                Reset entire election
              </button>
              <p className="text-xs text-uga-gray-mid text-center mt-2">
                Removes all votes and un-finalizes every office. Voter devices clear saved votes.
              </p>
            </div>
          </section>
        )}

        {/* ── All roles completed: winner list ── */}
        {status === "waiting" && incompleteRoles.length === 0 && roles.length > 0 && (
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <h2 className="font-display font-black text-xl text-uga-black mb-1 text-center">
              Election complete
            </h2>
            <p className="text-uga-gray-mid text-sm text-center mb-6">
              All {roles.length} roles finalized — plurality winner per office (ties noted).
            </p>
            {finalResultsError && (
              <p className="text-uga-red text-sm text-center font-medium mb-4">{finalResultsError}</p>
            )}
            <ul className="space-y-3">
              {finalWinners.map((w) => (
                <li
                  key={w.role_id}
                  className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 pb-3 border-b border-gray-100 last:border-0 last:pb-0"
                >
                  <span className="text-sm font-bold text-uga-black shrink-0">{w.title}</span>
                  <span className="text-sm text-uga-gray-mid sm:text-right">
                    <span className="font-semibold text-uga-black">{w.display}</span>
                    {w.is_tie && (
                      <span className="ml-2 text-amber-700 font-semibold">(tie)</span>
                    )}
                    {w.vote_count > 0 && (
                      <span className="text-uga-gray-mid font-normal ml-1 tabular-nums">
                        · {w.vote_count} {w.vote_count === 1 ? "vote" : "votes"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {finalWinners.length === 0 && !finalResultsError && (
              <p className="text-uga-gray-mid text-sm text-center">Loading results…</p>
            )}
            <button
              type="button"
              onClick={resetAllResults}
              disabled={loading}
              className="w-full mt-8 h-12 rounded-xl border-2 border-gray-300 text-uga-black font-bold
                         enabled:hover:bg-gray-50 disabled:opacity-40 transition-all"
            >
              Reset entire election
            </button>
            <p className="text-xs text-uga-gray-mid text-center mt-2">
              Same as in Review: clears every vote and reopens all offices.
            </p>
          </section>
        )}

        {/* ── Seed button (first-time setup) ── */}
        {roles.length === 0 && (
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 text-center">
            <h2 className="font-display font-black text-xl text-uga-black mb-2">
              No Election Data
            </h2>
            <p className="text-uga-gray-mid text-sm mb-4">
              Seed the database with the NSBE UGA election slate.
            </p>
            <button
              onClick={seedDatabase}
              disabled={loading}
              className="h-12 px-6 rounded-xl bg-uga-red text-white font-bold
                         enabled:hover:bg-uga-red-dark disabled:opacity-40 transition-all"
            >
              {loading ? "Seeding…" : "Seed Database"}
            </button>
          </section>
        )}

        {/* ── Member check-in (name at join — not ballot choices) — last tile ── */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-bold text-uga-gray-mid uppercase tracking-wider">
              Member check-in
            </h2>
            <button
              type="button"
              onClick={() => fetchCheckins()}
              disabled={checkinsLoading}
              className="text-xs font-bold text-uga-red px-3 py-1.5 rounded-lg border border-uga-red/30
                         hover:bg-red-50 disabled:opacity-40 transition-colors"
            >
              {checkinsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {checkinsError && (
            <p className="text-uga-red text-sm font-medium mb-2">
              {checkinsError}
              {checkinsError.includes("relation") || checkinsError.includes("does not exist") ? (
                <span className="block mt-1 font-normal text-uga-gray-mid">
                  Add the <code className="text-xs bg-gray-100 px-1 rounded">voter_checkins</code> table — run{" "}
                  <code className="text-xs bg-gray-100 px-1 rounded">lib/migration_voter_checkins.sql</code> in the
                  Supabase SQL editor. If check-in fails on a column error, also run{" "}
                  <code className="text-xs bg-gray-100 px-1 rounded">lib/migration_voter_checkins_dues_verify.sql</code>.
                </span>
              ) : null}
            </p>
          )}
          {!checkinsLoading && !checkinsError && memberCheckins.length === 0 && (
            <p className="text-sm text-uga-gray-mid">No one has checked in yet.</p>
          )}
          {memberCheckins.length > 0 && (
            <>
              <p className="text-xs font-bold text-uga-black mb-2 tabular-nums">
                {memberCheckins.length} checked in
                {checkinDuesStats.flagged > 0 ? (
                  <span className="ml-2 font-semibold text-amber-800">
                    · {checkinDuesStats.flagged} not on dues list
                  </span>
                ) : null}
                {checkinDuesStats.duplicateNames > 0 ? (
                  <span className="ml-2 font-semibold text-violet-900">
                    · {checkinDuesStats.duplicateNames} duplicate name
                    {checkinDuesStats.duplicateNames === 1 ? "" : "s"}
                  </span>
                ) : null}
              </p>
              <ul className="max-h-56 overflow-y-auto space-y-1.5 border border-gray-100 rounded-xl p-3 bg-gray-50/50">
                {memberCheckins.map((row) => (
                  <li
                    key={row.device_hash}
                    className={`text-sm flex flex-wrap items-center justify-between gap-2 min-w-0 rounded-lg px-2 py-1.5 -mx-2 ${
                      row.name_duplicate && row.dues_ok === false
                        ? "bg-amber-50 border border-amber-200/80 ring-2 ring-violet-300/80 ring-inset"
                        : row.name_duplicate
                        ? "bg-violet-50 border border-violet-200/90"
                        : row.dues_ok === false
                        ? "bg-amber-50 border border-amber-200/80"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                      <span className="font-medium text-uga-black truncate">{row.display_name}</span>
                      {row.name_duplicate && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-violet-900 bg-violet-200/90 px-1.5 py-0.5 rounded">
                          Duplicate name
                        </span>
                      )}
                      {row.dues_ok === false && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-amber-900 bg-amber-200/90 px-1.5 py-0.5 rounded">
                          Not on roster
                        </span>
                      )}
                      {row.dues_ok && (
                        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-green-800 bg-green-100 px-1.5 py-0.5 rounded">
                          Dues confirmed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <span className="text-xs text-uga-gray-mid tabular-nums">
                        {row.updated_at
                          ? new Date(row.updated_at).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                      {row.dues_ok === false && (
                        <button
                          type="button"
                          onClick={() => verifyCheckinDues(row.device_hash, row.display_name)}
                          disabled={
                            checkinVerifyingHash === row.device_hash || checkinRemovingHash === row.device_hash
                          }
                          className="text-xs font-bold text-green-800 px-2 py-1 rounded-md border border-green-700/35
                                     hover:bg-green-50 disabled:opacity-40 transition-colors"
                        >
                          {checkinVerifyingHash === row.device_hash ? "…" : "Confirm dues"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeCheckin(row.device_hash, row.display_name)}
                        disabled={
                          checkinRemovingHash === row.device_hash || checkinVerifyingHash === row.device_hash
                        }
                        className="text-xs font-bold text-uga-red px-2 py-1 rounded-md border border-uga-red/40
                                   hover:bg-red-50 disabled:opacity-40 transition-colors"
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADMIN PAGE ENTRY
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function AdminPage() {
  // null = probing cookie, false = logged out, true = authed
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/results", { credentials: "include" });
        if (!cancelled) setAuthed(res.ok);
      } catch {
        if (!cancelled) setAuthed(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSessionExpired = useCallback(async () => {
    try {
      await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {
      // best-effort; cookie will expire on its own
    }
    setAuthed(false);
  }, []);

  if (authed === null) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-uga-gray">
        <p className="text-sm text-uga-gray-mid">Loading…</p>
      </div>
    );
  }
  if (!authed) return <AdminLogin onLogin={() => setAuthed(true)} />;
  return <Dashboard onSessionExpired={handleSessionExpired} />;
}
