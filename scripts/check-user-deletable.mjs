/**
 * Read-only. For every user, reports whether Delete would be allowed, and if
 * not, exactly what is blocking it.
 *
 *   npm run check:deletable
 *
 * Mirrors the guards in deleteUserAction(): last-active-admin, and the six
 * ON DELETE RESTRICT foreign keys that point at profiles. Deletes nothing.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const REFS = [
  ["payments they collected", "payments", "collected_by"],
  ["payments they voided", "payments", "voided_by"],
  ["cash submissions they made", "cash_submissions", "collector_id"],
  ["cash submissions they received", "cash_submissions", "received_by"],
  ["bill adjustments they approved", "monthly_bills", "adjusted_by"],
  ["rate changes they made", "client_rate_history", "changed_by"],
];

const { data: users, error } = await admin
  .from("profiles").select("id, full_name, email, role, is_active").order("created_at");
if (error) { console.error(error.message); process.exit(1); }

const activeAdmins = users.filter((u) => u.role === "admin" && u.is_active).length;
console.log(`\n${users.length} users - ${activeAdmins} active admin(s)\n${"=".repeat(72)}`);

for (const u of users) {
  const blockers = [];
  if (u.role === "admin" && u.is_active && activeAdmins <= 1) blockers.push("last active admin");
  for (const [label, table, column] of REFS) {
    const { count } = await admin.from(table).select("*", { count: "exact", head: true }).eq(column, u.id);
    if (count) blockers.push(`${count} ${label}`);
  }
  const tag = blockers.length ? "BLOCKED " : "DELETABLE";
  console.log(`\n[${tag}] ${u.full_name}  <${u.email}>  ${u.role}${u.is_active ? "" : " (inactive)"}`);
  console.log(`           ${u.id}`);
  if (blockers.length) console.log(`           blocked by: ${blockers.join(", ")}`);
}
console.log(`\n${"=".repeat(72)}\nNothing was changed - this script only reads.\n`);
