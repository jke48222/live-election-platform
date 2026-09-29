/**
 * Who won a race. Pure, so it can be unit tested.
 *
 * Each voter has one vote per race. A race fills `seats` (positions.max_winners)
 * seats with the candidates who got the most votes. A candidate with no votes
 * never takes a seat. When the candidate in the last seat has as many votes
 * as the next one, the race is a tie for the seats that are left, and
 * `tied` names everyone on that count.
 *
 * With one seat this is the original rule: the leaders are everyone on the
 * top count, and it is a tie when there is more than one.
 */

/**
 * @param {{id: string, name: string}[]} candidates active candidates
 * @param {Record<string, number>} counts votes by candidate id
 * @param {number} seats how many candidates win (1 or more)
 */
export function tallySeats(candidates, counts, seats = 1) {
  const n = Math.max(1, Math.floor(Number(seats)) || 1);
  if (!candidates.length) {
    return { names: [], winners: [], tied: [], open_seats: 0, is_tie: false, vote_count: 0, display: "No candidates" };
  }
  const ranked = candidates
    .map((c) => ({ name: c.name, votes: counts[c.id] || 0 }))
    .filter((c) => c.votes > 0)
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  if (!ranked.length) {
    return { names: [], winners: [], tied: [], open_seats: 0, is_tie: false, vote_count: 0, display: "No votes" };
  }
  const top = ranked[0].votes;

  if (ranked.length <= n || ranked[n - 1].votes > ranked[n].votes) {
    const winners = ranked.slice(0, n).map((c) => c.name);
    return {
      names: winners,
      winners,
      tied: [],
      open_seats: 0,
      is_tie: false,
      vote_count: top,
      display: winners.join(" · "),
    };
  }

  const cutoff = ranked[n - 1].votes;
  const winners = ranked.filter((c) => c.votes > cutoff).map((c) => c.name);
  const tied = ranked.filter((c) => c.votes === cutoff).map((c) => c.name);
  const open = n - winners.length;
  const seatsText = open === 1 ? "seat" : `${open} seats`;
  let display = tied.join(" · ");
  if (winners.length) display = `${winners.join(" · ")} · tied for the last ${seatsText}: ${display}`;
  else if (n > 1) display = `Tied for ${seatsText}: ${display}`;
  return {
    names: [...winners, ...tied],
    winners,
    tied,
    open_seats: open,
    is_tie: true,
    vote_count: top,
    display,
  };
}

/**
 * Parse max_winners from a request body. Returns { value } for a whole
 * number from 1 to 50 (a numeric string is fine), { value: fallback } when
 * the field is absent, or { error } otherwise.
 */
export function parseMaxWinners(raw, fallback = 1) {
  if (raw === undefined || raw === null) return { value: fallback };
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) {
    return { error: "max_winners must be a whole number from 1 to 50." };
  }
  return { value: n };
}
