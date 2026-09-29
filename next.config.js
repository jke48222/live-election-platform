const { PHASE_PRODUCTION_SERVER } = require("next/constants");
const { assertProductionEnv } = require("./scripts/production-env.cjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = (phase) => {
  // `next start` refuses to come up without APP_DATABASE_URL and
  // REALTIME_SECRET. Next loads .env.local before this runs.
  if (phase === PHASE_PRODUCTION_SERVER) assertProductionEnv(process.env);
  return nextConfig;
};
