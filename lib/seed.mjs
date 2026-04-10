import { createClient } from "@supabase/supabase-js";
import { ELECTION_SLATE } from "./seed-data.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Use: npm run seed (loads .env.local), or export those variables."
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

await supabase
  .from("voter_checkins")
  .delete()
  .neq("id", "00000000-0000-0000-0000-000000000000");
await supabase
  .from("votes")
  .delete()
  .neq("id", "00000000-0000-0000-0000-000000000000");
await supabase
  .from("candidates")
  .delete()
  .neq("id", "00000000-0000-0000-0000-000000000000");
await supabase.from("roles").delete().neq("id", "____");

const { data: stateRow } = await supabase.from("election_state").select("id").single();
if (stateRow) {
  await supabase
    .from("election_state")
    .update({
      status: "waiting",
      active_role_id: null,
      poll_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", stateRow.id);
} else {
  await supabase.from("election_state").insert({
    status: "waiting",
    active_role_id: null,
    poll_expires_at: null,
  });
}

const roleRows = ELECTION_SLATE.map((r) => ({
  id: r.id,
  title: r.title,
  sort_order: r.sort_order,
  is_completed: false,
}));

const { error: roleErr } = await supabase.from("roles").insert(roleRows);
if (roleErr) {
  console.error(roleErr.message);
  process.exit(1);
}

const candidateRows = [];
for (const role of ELECTION_SLATE) {
  for (const name of role.candidates) {
    candidateRows.push({
      role_id: role.id,
      name,
      is_active: true,
    });
  }
}

const { error: candErr } = await supabase.from("candidates").insert(candidateRows);
if (candErr) {
  console.error(candErr.message);
  process.exit(1);
}

console.log(
  `Seeded ${roleRows.length} roles and ${candidateRows.length} candidates.`
);
