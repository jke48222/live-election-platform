import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { withOrg } from "../../../lib/db";
import { authorizeElection } from "../../../lib/auth";
import { isUuid } from "../../../lib/api-helpers";
import { normalizeIdentifier } from "../../../lib/eligibility";

/**
 * Roster / eligibility-list management for an election (admin only). Backs the
 * roster_csv, email_magic_link, and access_code providers via eligible_voters.
 *   GET    ?election_id=          → list entries + stats
 *   POST   { identifiers | text } → bulk add names/emails (roster/email modes)
 *   POST   { generate_codes: N }  → mint N single-use access codes
 *   DELETE { id } | { all:true }  → remove one entry or clear the list
 */

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const MAX_ITEMS = 5000;
const MAX_CODES = 2000;

function generateCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

async function authorize(req, electionId) {
  if (!isUuid(electionId)) return { error: "election_id required", status: 400 };
  const auth = await authorizeElection(req, electionId);
  if (!auth) return { error: "Unauthorized", status: 401 };
  return auth;
}

export async function GET(req) {
  const electionId = new URL(req.url).searchParams.get("election_id") || "";
  const auth = await authorize(req, electionId);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const data = await withOrg(auth.orgId, async (db) => {
      const { rows } = await db.query(
        `SELECT id, identifier, label, token, used_at, claimed_by_device, created_at
           FROM eligible_voters WHERE election_id = $1 ORDER BY created_at`,
        [electionId]
      );
      return rows;
    });
    const used = data.filter((r) => r.used_at).length;
    return NextResponse.json({ entries: data, total: data.length, used });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const auth = await authorize(req, body?.election_id);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const orgExpr = "nullif(current_setting('app.current_org',true),'')::uuid";

  try {
    // ── Generate access codes ──
    if (body.generate_codes != null) {
      const n = Math.max(1, Math.min(MAX_CODES, Number(body.generate_codes) || 0));
      const created = await withOrg(auth.orgId, async (db) => {
        const out = [];
        for (let i = 0; i < n; i++) {
          // Retry on the rare collision against this election's existing codes.
          let inserted = null;
          for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
            const code = generateCode();
            const { rows } = await db.query(
              `INSERT INTO eligible_voters (election_id, org_id, identifier, label, token)
               VALUES ($1, ${orgExpr}, $2, $3, $4)
               ON CONFLICT (election_id, identifier) DO NOTHING
               RETURNING token`,
              [body.election_id, code.toLowerCase(), body.label || null, code]
            );
            if (rows[0]) inserted = rows[0].token;
          }
          if (inserted) out.push(inserted);
        }
        return out;
      });
      return NextResponse.json({ codes: created, added: created.length });
    }

    // ── Add identifiers (names / emails) ──
    let raw = [];
    if (Array.isArray(body.identifiers)) raw = body.identifiers;
    else if (typeof body.text === "string") raw = body.text.split(/[\n,]/);
    const items = [...new Set(raw.map(normalizeIdentifier).filter(Boolean))].slice(0, MAX_ITEMS);
    if (items.length === 0) {
      return NextResponse.json({ error: "No valid entries provided." }, { status: 400 });
    }

    const added = await withOrg(auth.orgId, async (db) => {
      let count = 0;
      for (const id of items) {
        const { rowCount } = await db.query(
          `INSERT INTO eligible_voters (election_id, org_id, identifier, label)
           VALUES ($1, ${orgExpr}, $2, $3)
           ON CONFLICT (election_id, identifier) DO NOTHING`,
          [body.election_id, id, id]
        );
        count += rowCount;
      }
      return count;
    });
    return NextResponse.json({ added, submitted: items.length });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const auth = await authorize(req, body?.election_id);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const removed = await withOrg(auth.orgId, async (db) => {
      if (body.all) {
        const { rowCount } = await db.query("DELETE FROM eligible_voters WHERE election_id = $1", [body.election_id]);
        return rowCount;
      }
      if (!isUuid(body.id)) return -1;
      const { rowCount } = await db.query(
        "DELETE FROM eligible_voters WHERE id = $1 AND election_id = $2",
        [body.id, body.election_id]
      );
      return rowCount;
    });
    if (removed === -1) return NextResponse.json({ error: "id or all required" }, { status: 400 });
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
