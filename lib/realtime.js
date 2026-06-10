/**
 * Server-side realtime emit — the replacement for
 * `supabase.channel("election_room").send(...)`.
 *
 * Emits an event to all clients in an election's room by issuing a Postgres
 * NOTIFY that the realtime gateway (services/realtime/server.mjs) relays.
 * Pass the transaction client from withOrg() so the NOTIFY fires on COMMIT —
 * voters never see an event for a change that rolled back.
 *
 *   await withOrg(orgId, async (db) => {
 *     await db.query("UPDATE elections SET status='voting' WHERE id=$1", [electionId]);
 *     await emit(db, electionId, "state_change", { status: "voting", ... });
 *   });
 *
 * Postgres NOTIFY payloads are capped at ~8000 bytes, so keep events small —
 * send a signal + ids and let the client refetch detail when needed.
 */
const NOTIFY_CHANNEL = "election_events";
const MAX_PAYLOAD = 7800;

export async function emit(client, electionId, event, data = null) {
  if (!client?.query) throw new Error("emit requires a pg client/pool");
  if (!electionId || !event) throw new Error("emit requires electionId and event");
  const payload = JSON.stringify({ electionId: String(electionId), event, data });
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`realtime payload too large (${payload.length} bytes)`);
  }
  await client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, payload]);
}
