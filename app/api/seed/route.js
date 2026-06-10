import { NextResponse } from "next/server";

/**
 * Deprecated. The single-tenant NSBE seed (14 roles / 39 candidates) is gone —
 * elections are now created per-organization through the onboarding/builder
 * flow (Phase 4), never seeded. For local development fixtures use
 * `npm run db:seed` (db/seed.mjs), which loads a generic demo org.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Seeding is deprecated. Create elections via the builder; use `npm run db:seed` for local demo data.",
    },
    { status: 410 }
  );
}
