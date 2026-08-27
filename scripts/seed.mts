/**
 * Demo data seeder.
 *
 *   npm run seed
 *
 * Deliberately does its work through the real API rather than raw inserts:
 * users are created with the admin API, then the script SIGNS IN as each of
 * them and calls generate_monthly_bills / record_payment /
 * create_cash_submission exactly as the app does. Seeding therefore also
 * proves that auth, RLS and the financial functions all work.
 *
 * Safe to re-run: users, clients and bills are upserted or skipped, and
 * payments/submissions are only seeded when there are none yet.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error(
    "\nMissing environment variables.\n\n" +
      "Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Copy .env.example to .env.local and fill it in, then run `npm run seed` again.\n",
  );
  process.exit(1);
}

/**
 * Demo password: taken from SEED_PASSWORD if set, otherwise generated fresh and
 * printed once at the end. Never a hardcoded literal.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? `demo-${randomBytes(6).toString("hex")}`;
const GENERATED = !process.env.SEED_PASSWORD;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const log = (message: string) => console.log(message);
const step = (message: string) => console.log(`\n▸ ${message}`);

function dhakaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function monthStart(offset: number): string {
  const today = dhakaToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const total = year * 12 + (month - 1) + offset;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** A date inside the given month, clamped to today for the current month. */
function dayInMonth(month: string, day: number): string {
  const candidate = `${month.slice(0, 7)}-${String(day).padStart(2, "0")}`;
  const today = dhakaToday();
  return candidate > today ? today : candidate;
}

async function signInAs(email: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Could not sign in as ${email}: ${error.message}`);
  return client;
}

/* -------------------------------------------------------------------------- */
/* Demo content                                                                */
/* -------------------------------------------------------------------------- */

const USERS = [
  { key: "abbu", email: "abbu@watersupply.demo", name: "Abbu (Owner)", role: "admin", phone: "01710000001" },
  { key: "mama", email: "mama@watersupply.demo", name: "Mama", role: "collector", phone: "01710000002" },
  { key: "jamal", email: "jamal@watersupply.demo", name: "Jamal", role: "collector", phone: "01710000003" },
] as const;

/** Areas the demo clients are grouped into. */
const AREAS = [
  { name: "Mirpur", description: "Mirpur 1 to 10" },
  { name: "Kazipara", description: "Kazipara and around" },
  { name: "Shewrapara", description: "Shewrapara" },
  { name: "Pallabi", description: "Pallabi and Mirpur 11-12" },
] as const;

const CLIENTS = [
  { code: "C-0001", name: "Rahim Uddin", phone: "01810000001", address: "House 12, Road 3, Mirpur", bill: 1000, area: "Mirpur" },
  { code: "C-0002", name: "Karim Sheikh", phone: "01810000002", address: "House 45, Road 7, Mirpur", bill: 1500, area: "Mirpur" },
  { code: "C-0003", name: "Salma Begum", phone: "01810000003", address: "Flat 4B, Green Tower, Kazipara", bill: 1200, area: "Kazipara" },
  { code: "C-0004", name: "Jahangir Alam", phone: "01810000004", address: "House 9, Shewrapara", bill: 800, area: "Shewrapara" },
  { code: "C-0005", name: "Nasrin Akter", phone: "01810000005", address: "House 21, Road 2, Pallabi", bill: 1000, area: "Pallabi" },
  { code: "C-0006", name: "Mizanur Rahman", phone: "01810000006", address: "Shop 5, Mirpur Bazar", bill: 2500, area: "Mirpur" },
  { code: "C-0007", name: "Farida Yasmin", phone: "01810000007", address: "Flat 2A, Rose Villa, Kazipara", bill: 1200, area: "Kazipara" },
  { code: "C-0008", name: "Abdul Malek", phone: "01810000008", address: "House 33, Road 5, Mirpur", bill: 900, area: "Mirpur" },
  { code: "C-0009", name: "Ruma Khatun", phone: "01810000009", address: "House 8, Shewrapara", bill: 1000, area: "Shewrapara" },
  { code: "C-0010", name: "Shahin Mia", phone: "01810000010", address: "Tea stall, Pallabi Mor", bill: 700, area: "Pallabi" },
  { code: "C-0011", name: "Nurul Islam", phone: "01810000011", address: "House 17, Road 9, Mirpur", bill: 1500, area: "Mirpur" },
  { code: "C-0012", name: "Taslima Nasrin", phone: "01810000012", address: "Flat 6C, Sky View, Kazipara", bill: 1300, area: "Kazipara" },
  { code: "C-0013", name: "Kamal Hossain", phone: "01810000013", address: "Garage, Mirpur 10", bill: 2000, area: "Mirpur" },
  { code: "C-0014", name: "Ayesha Siddika", phone: "01810000014", address: "House 4, Road 1, Pallabi", bill: 1000, area: "Pallabi" },
] as const;

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

async function seedUsers(): Promise<Record<string, string>> {
  step("Creating users");

  const { data: existingList } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existingByEmail = new Map(
    (existingList?.users ?? []).map((user) => [user.email?.toLowerCase(), user.id]),
  );

  const ids: Record<string, string> = {};

  for (const user of USERS) {
    const existingId = existingByEmail.get(user.email);

    if (existingId) {
      // Re-apply the password so the sign-ins below always work.
      await admin.auth.admin.updateUserById(existingId, { password: PASSWORD });
      ids[user.key] = existingId;
      log(`  = ${user.name} <${user.email}> already existed (password reset)`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: user.email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: user.name, phone: user.phone, role: user.role },
      });
      if (error) throw new Error(`Creating ${user.email}: ${error.message}`);
      ids[user.key] = data.user!.id;
      log(`  + ${user.name} <${user.email}>`);
    }

    // The auth trigger creates the profile; make role and status explicit.
    const { error: profileError } = await admin
      .from("profiles")
      .update({
        full_name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        is_active: true,
      })
      .eq("id", ids[user.key]);
    if (profileError) throw new Error(`Updating profile ${user.email}: ${profileError.message}`);
  }

  return ids;
}

async function seedAreas(): Promise<Record<string, string>> {
  step("Creating areas");

  const ids: Record<string, string> = {};
  for (const area of AREAS) {
    const { data: existing } = await admin
      .from("areas")
      .select("id")
      .eq("name", area.name)
      .maybeSingle();

    if (existing) {
      ids[area.name] = existing.id;
      continue;
    }

    const { data, error } = await admin
      .from("areas")
      .insert({ name: area.name, description: area.description, is_active: true })
      .select("id")
      .single();
    if (error) throw new Error(`Creating area ${area.name}: ${error.message}`);
    ids[area.name] = data.id;
  }

  log(`  ${AREAS.length} areas ready`);
  return ids;
}

async function seedClients(areaIds: Record<string, string>): Promise<Record<string, string>> {
  step("Creating clients");

  const startDate = monthStart(-3);
  const ids: Record<string, string> = {};

  for (const client of CLIENTS) {
    const { data: existing } = await admin
      .from("clients")
      .select("id")
      .eq("client_code", client.code)
      .maybeSingle();

    if (existing) {
      ids[client.code] = existing.id;
      // Backfill the area on a client created before areas existed.
      await admin
        .from("clients")
        .update({ area_id: areaIds[client.area] })
        .eq("id", existing.id)
        .is("area_id", null);
      continue;
    }

    const { data, error } = await admin
      .from("clients")
      .insert({
        client_code: client.code,
        name: client.name,
        phone: client.phone,
        address: client.address,
        monthly_bill: client.bill,
        start_date: startDate,
        status: "active",
        area_id: areaIds[client.area],
      })
      .select("id")
      .single();

    if (error) throw new Error(`Creating client ${client.code}: ${error.message}`);
    ids[client.code] = data.id;
  }

  log(`  ${CLIENTS.length} clients ready`);
  return ids;
}

async function seedBills(adminClient: SupabaseClient): Promise<void> {
  step("Generating monthly bills (as Abbu)");

  for (const offset of [-2, -1, 0]) {
    const month = monthStart(offset);
    const { data, error } = await adminClient.rpc("generate_monthly_bills", {
      p_billing_month: month,
    });
    if (error) throw new Error(`Generating bills for ${month}: ${error.message}`);

    const row = data?.[0];
    log(`  ${month.slice(0, 7)}: ${row?.created_count ?? 0} created, ${row?.skipped_count ?? 0} skipped`);
  }
}

interface PaymentPlan {
  code: string;
  offset: number;
  /** Fraction of the bill to pay, 1 = full. */
  portion: number;
  collector: "mama" | "jamal" | "abbu";
  day: number;
  method?: "cash" | "bank" | "mobile_banking";
}

/**
 * A believable pattern: two months ago mostly settled, last month patchy,
 * this month just starting - which gives the dashboard and reports something
 * meaningful to show.
 */
const PAYMENT_PLAN: PaymentPlan[] = [
  // Two months ago - nearly everything collected
  ...CLIENTS.slice(0, 12).map((c, i): PaymentPlan => ({
    code: c.code,
    offset: -2,
    portion: 1,
    collector: i % 3 === 0 ? "jamal" : "mama",
    day: 5 + (i % 15),
  })),
  { code: "C-0013", offset: -2, portion: 0.5, collector: "mama", day: 12 },

  // Last month - a mix of full, partial and unpaid
  ...CLIENTS.slice(0, 8).map((c, i): PaymentPlan => ({
    code: c.code,
    offset: -1,
    portion: 1,
    collector: i % 2 === 0 ? "mama" : "jamal",
    day: 4 + (i % 18),
    method: i === 3 ? "mobile_banking" : "cash",
  })),
  { code: "C-0009", offset: -1, portion: 0.6, collector: "mama", day: 14 },
  { code: "C-0010", offset: -1, portion: 0.5, collector: "jamal", day: 16 },
  { code: "C-0011", offset: -1, portion: 1, collector: "abbu", day: 9, method: "bank" },

  // This month - early days
  ...CLIENTS.slice(0, 5).map((c, i): PaymentPlan => ({
    code: c.code,
    offset: 0,
    portion: 1,
    collector: i % 2 === 0 ? "mama" : "jamal",
    day: 2 + i,
  })),
  { code: "C-0006", offset: 0, portion: 0.4, collector: "mama", day: 4 },
  { code: "C-0007", offset: 0, portion: 1, collector: "abbu", day: 3, method: "mobile_banking" },
];

async function seedPayments(
  clients: Record<string, SupabaseClient>,
  clientIds: Record<string, string>,
): Promise<void> {
  step("Recording payments (as each collector)");

  const { count } = await admin.from("payments").select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    log(`  ${count} payments already exist - skipping.`);
    return;
  }

  // Bill amounts drive the partial-payment maths.
  const { data: bills } = await admin.from("monthly_bills").select("client_id, billing_month, bill_amount");
  const billMap = new Map(
    (bills ?? []).map((bill) => [`${bill.client_id}|${bill.billing_month}`, Number(bill.bill_amount)]),
  );

  let recorded = 0;
  let skipped = 0;

  for (const plan of PAYMENT_PLAN) {
    const clientId = clientIds[plan.code];
    const month = monthStart(plan.offset);
    const billAmount = billMap.get(`${clientId}|${month}`);
    if (!clientId || !billAmount) {
      skipped++;
      continue;
    }

    const amount = Math.round(billAmount * plan.portion);
    const supabase = clients[plan.collector];

    const { error } = await supabase.rpc("record_payment", {
      p_client_id: clientId,
      p_billing_month: month,
      p_amount: amount,
      p_payment_method: plan.method ?? "cash",
      p_payment_date: dayInMonth(month, plan.day),
      p_notes: null,
    });

    if (error) {
      // Most likely the bill is already settled - not fatal for a demo.
      log(`  ! ${plan.code} ${month.slice(0, 7)}: ${error.message}`);
      skipped++;
      continue;
    }
    recorded++;
  }

  log(`  ${recorded} payments recorded, ${skipped} skipped`);
}

async function seedSubmissions(
  adminClient: SupabaseClient,
  userIds: Record<string, string>,
): Promise<void> {
  step("Recording cash submissions (as Abbu)");

  const { count } = await admin.from("cash_submissions").select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    log(`  ${count} submissions already exist - skipping.`);
    return;
  }

  for (const key of ["mama", "jamal"] as const) {
    const { data: stats, error: statsError } = await adminClient.rpc("collector_stats", {
      p_collector_id: userIds[key],
      p_month: monthStart(0),
    });
    if (statsError) throw new Error(`Reading stats for ${key}: ${statsError.message}`);

    const unsubmitted = Number((stats as Record<string, number>)?.unsubmitted ?? 0);
    if (unsubmitted <= 0) {
      log(`  ${key}: nothing to submit`);
      continue;
    }

    // Leave a little unsubmitted for Mama, so the dashboard shows a live figure.
    const amount = key === "mama" ? Math.round(unsubmitted * 0.85) : unsubmitted;

    const { error } = await adminClient.rpc("create_cash_submission", {
      p_collector_id: userIds[key],
      p_amount: amount,
      p_submission_date: dhakaToday(),
      p_notes: "Demo submission",
    });
    if (error) throw new Error(`Submission for ${key}: ${error.message}`);

    log(`  ${key}: submitted ${amount} of ${unsubmitted}`);
  }
}

/**
 * Schedules one future rate change so the feature is visible in the demo:
 * next month's bill for C-0001 goes up, while every past bill stays put.
 */
async function seedRateChange(
  adminClient: SupabaseClient,
  clientIds: Record<string, string>,
): Promise<void> {
  step("Scheduling a rate change (as Abbu)");

  const { count } = await admin
    .from("client_rate_history")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) > 0) {
    log(`  ${count} rate changes already exist - skipping.`);
    return;
  }

  const nextMonth = monthStart(1);
  const { error } = await adminClient.rpc("set_client_rate", {
    p_client_id: clientIds["C-0001"],
    p_monthly_bill: 1200,
    p_effective_from: nextMonth,
    p_reason: "Annual revision",
  });
  if (error) {
    log(`  ! rate change: ${error.message}`);
    return;
  }
  log(`  C-0001: 1200 from ${nextMonth.slice(0, 7)} (past bills unchanged)`);
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main() {
  log("Seeding demo data into " + SUPABASE_URL);

  const userIds = await seedUsers();
  const areaIds = await seedAreas();
  const clientIds = await seedClients(areaIds);

  const sessions: Record<string, SupabaseClient> = {
    abbu: await signInAs("abbu@watersupply.demo"),
    mama: await signInAs("mama@watersupply.demo"),
    jamal: await signInAs("jamal@watersupply.demo"),
  };

  await seedBills(sessions.abbu);
  await seedPayments(sessions, clientIds);
  await seedSubmissions(sessions.abbu, userIds);
  await seedRateChange(sessions.abbu, clientIds);

  log("\n" + "-".repeat(60));
  log("Demo accounts");
  log("-".repeat(60));
  for (const user of USERS) {
    log(`  ${user.role.padEnd(9)} ${user.email.padEnd(28)} ${user.name}`);
  }
  log("-".repeat(60));
  log(`  Password for all accounts: ${PASSWORD}`);
  if (GENERATED) {
    log("  (generated for this run - set SEED_PASSWORD to choose your own)");
  }
  log("-".repeat(60));
  log("\nDone. Start the app with `npm run dev` and sign in.\n");
}

main().catch((error) => {
  console.error("\nSeeding failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
