#!/usr/bin/env node
/**
 * DEV-ONLY seed — generic demo data, NO hardcoded NSBE slate.
 *
 *   node --env-file=.env.local db/seed.mjs
 *
 * Creates the subscription plans and one demo organization with a small
 * sample election so a fresh checkout has something to look at. Runs as the
 * owner/superuser (DATABASE_URL) which bypasses RLS. Idempotent: re-running
 * upserts plans and skips the demo org if its slug already exists.
 *
 * Real organizations and elections are created through the onboarding flow,
 * never seeded.
 */
import pg from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/elections";

const PLANS = [
  { key: "free_beta",  name: "Free Beta",    price_cents: 0,    interval: "none",
    limits: { max_active_elections: null, max_voters: null, branding: true, sso: true, seats: 99 } },
  { key: "individual", name: "Individual",   price_cents: 0,    interval: "month",
    limits: { max_active_elections: 1, max_voters: 100, branding: false, sso: false, seats: 1 } },
  { key: "org",        name: "Organization", price_cents: 2000, interval: "month",
    limits: { max_active_elections: null, max_voters: 2000, branding: true, sso: false, seats: 3 } },
  { key: "college",    name: "College",      price_cents: 0,    interval: "month",
    limits: { max_active_elections: null, max_voters: null, branding: true, sso: true, seats: 25 } },
];

async function main() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    // 1. Plans (upsert by key).
    for (const p of PLANS) {
      await c.query(
        `INSERT INTO plans (key, name, price_cents, interval, limits)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE
           SET name=EXCLUDED.name, price_cents=EXCLUDED.price_cents,
               interval=EXCLUDED.interval, limits=EXCLUDED.limits`,
        [p.key, p.name, p.price_cents, p.interval, JSON.stringify(p.limits)]
      );
    }
    console.log(`✓ ${PLANS.length} plans upserted`);

    // 2. Demo org — skip if present.
    const existing = await c.query("SELECT id FROM organizations WHERE slug = $1", ["demo"]);
    if (existing.rows.length) {
      console.log("✓ demo org already exists — skipping sample election");
      return;
    }

    const betaPlan = await c.query("SELECT id FROM plans WHERE key = $1", ["free_beta"]);
    const org = await c.query(
      `INSERT INTO organizations (slug, name, type, plan_id, subscription_status, branding)
       VALUES ('demo','Demo Organization','club',$1,'beta',$2) RETURNING id`,
      [betaPlan.rows[0].id, JSON.stringify({ primary_color: "#2563eb", display_name: "Demo Organization" })]
    );
    const orgId = org.rows[0].id;

    const election = await c.query(
      `INSERT INTO elections (org_id, slug, title, description, mode, status, eligibility_mode, pin)
       VALUES ($1,'spring-2026','Spring 2026 Board Election',
               'Sample election seeded for local development.',
               'live_presenter','waiting','pin','1975') RETURNING id`,
      [orgId]
    );
    const electionId = election.rows[0].id;

    const positions = [
      { title: "President", candidates: ["Avery Stone", "Jordan Blake"] },
      { title: "Treasurer", candidates: ["Sam Rivera", "Casey Lin", "Drew Patel"] },
    ];
    let sort = 0;
    for (const pos of positions) {
      const pr = await c.query(
        `INSERT INTO positions (election_id, org_id, title, sort_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [electionId, orgId, pos.title, sort++]
      );
      const positionId = pr.rows[0].id;
      let cSort = 0;
      for (const name of pos.candidates) {
        await c.query(
          `INSERT INTO candidates (position_id, org_id, name, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [positionId, orgId, name, cSort++]
        );
      }
    }
    console.log(`✓ demo org + sample election created (org=${orgId})`);
    console.log("  voter PIN: 1975 · election slug: demo/spring-2026");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
