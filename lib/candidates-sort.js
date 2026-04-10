/** Last word of trimmed name, lowercased — "First Last" → last name key. */
function lastNameSortKey(name) {
  const t = String(name ?? "").trim();
  if (!t) return "";
  const parts = t.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLocaleLowerCase() : "";
}

/** Compare two { name } candidates by last name, then full name. */
export function compareCandidatesByLastName(a, b) {
  const ka = lastNameSortKey(a.name);
  const kb = lastNameSortKey(b.name);
  const c = ka.localeCompare(kb);
  if (c !== 0) return c;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
}

export function sortCandidatesByLastName(candidates) {
  return [...(candidates || [])].sort(compareCandidatesByLastName);
}
