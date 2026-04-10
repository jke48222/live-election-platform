import { createClient } from "@supabase/supabase-js";

/* ── Browser client (anon key, safe for voters) ── */
let _browser;
export function getSupabaseBrowser() {
  if (_browser) return _browser;
  _browser = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      realtime: {
        params: { eventsPerSecond: 10 },
        worker: true,            // offload heartbeat to Web Worker
      },
    }
  );
  return _browser;
}

/* ── Server client (service role key, admin-only API routes) ── */
export function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
