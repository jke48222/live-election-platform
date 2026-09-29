import { NextResponse } from "next/server";

/**
 * Deprecated. The single-tenant seed from the first version is gone.
 * Elections are created per organization through the onboarding and builder
 * flow, never seeded. This handler touches no data and answers 410 to every
 * caller, signed in or not, in every environment. For local development fixtures use
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
