/**
 * Feature check for 0005 (areas + rate history) and 0006 (analytics).
 *
 *   npm run verify:analytics
 *
 * Applies the whole migration chain to PGlite, then walks the addendum's
 * test scenarios: rate changes that must not touch history, areas, the
 * year x month matrix, area summaries, and the client list with this month's
 * figures attached.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const FILES = [
  "0001_init_schema", "0002_functions", "0003_rls_policies",
  "0004_bill_adjustments", "0005_areas_and_rates", "0006_analytics",
];

const db = new PGlite({ extensions: { pg_trgm } });
let pass = 0, fail = 0;
const failures = [];

const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

async function expectError(name, fn, token) {
  try { await fn(); fail++; failures.push(name); console.log(`  FAIL  ${name} (expected rejection)`); }
  catch (e) {
    const m = String(e.message ?? e);
    if (!token || m.includes(token)) { pass++; console.log(`  PASS  ${name} -> ${m.split("\n")[0].slice(0, 55)}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name} (wrong error: ${m.split("\n")[0]})`); }
  }
}

const as = (id) => db.exec(`select set_config('app.current_user_id', '${id ?? ""}', false);`);
const toDateStr = (v) => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v).slice(0, 10);
const one = async (q) => (await db.query(q)).rows[0];

function shiftMonth(month, n) {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

async function main() {
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);
  for (const f of FILES) await db.exec(readFileSync(join(MIGRATIONS, `${f}.sql`), "utf8"));
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);
  console.log("== Migrations applied ==");

  const abbu = randomUUID(), mama = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}');`);
  await as(abbu);

  const thisMonth = toDateStr((await one(`select public.dhaka_current_month() m`)).m);
  const prevMonth = shiftMonth(thisMonth, -1);
  const prev2 = shiftMonth(thisMonth, -2);
  const nextMonth = shiftMonth(thisMonth, 1);

  /* ------------------------------------------------------------- AREAS */
  console.log("\n== Areas: create, edit, deactivate (section 18) ==");
  const mkArea = async (n) => (await one(`select (public.upsert_area(null,'${n}','desc',true)).id id`)).id;
  const area1 = await mkArea("Area 1");
  const area2 = await mkArea("Area 2");
  check("areas created", Boolean(area1 && area2));

  await db.query(`select public.upsert_area('${area1}','Area 1','Mirpur side',true)`);
  check("area edited", (await one(`select description d from public.areas where id='${area1}'`)).d === "Mirpur side");

  await db.query(`select public.upsert_area('${area2}','Area 2',null,false)`);
  check("area deactivated", (await one(`select is_active a from public.areas where id='${area2}'`)).a === false);
  await db.query(`select public.upsert_area('${area2}','Area 2',null,true)`);

  await expectError("duplicate area name rejected",
    () => db.query(`select public.upsert_area(null,'Area 1',null,true)`), "duplicate key");

  /* ----------------------------------------------------------- CLIENTS */
  console.log("\n== Clients with areas (section 19) ==");
  const mk = async (code, name, amt, area) => (await one(
    `select (public.upsert_client(null,'${code}','${name}',null,null,${amt},'${prev2}','active',null,${area ? `'${area}'` : "null"})).id id`)).id;

  const rahim = await mk("C-1", "Rahim", 1000, area1);
  const karim = await mk("C-2", "Karim", 1000, area1);
  const hasan = await mk("C-3", "Hasan", 1200, area2);
  const noArea = await mk("C-4", "Nobody", 500, null);
  check("clients created with areas", Boolean(rahim && karim && hasan && noArea));

  await db.query(`select public.set_client_area('${hasan}','${area1}')`);
  check("client reassigned to another area",
    (await one(`select area_id a from public.clients where id='${hasan}'`)).a === area1);
  await db.query(`select public.set_client_area('${hasan}','${area2}')`);

  await expectError("area with clients cannot be deleted",
    () => db.query(`select public.delete_area('${area1}')`), "AREA_HAS_CLIENTS");

  /* ------------------------------------------------- TEST 1: RATE CHANGE */
  console.log("\n== Addendum Test 1 + section 28: rate change must not touch history ==");
  for (const m of [prev2, prevMonth, thisMonth]) {
    await db.query(`select * from public.generate_monthly_bills('${m}')`);
  }
  const before = await db.query(
    `select billing_month, bill_amount::float8 amt from public.monthly_bills
      where client_id='${rahim}' order by billing_month`);
  check("three bills at ৳1,000", before.rows.length === 3 && before.rows.every((r) => r.amt === 1000),
    JSON.stringify(before.rows.map((r) => r.amt)));

  // Schedule ৳1,200 from next month.
  await db.query(`select public.set_client_rate('${rahim}',1200,'${nextMonth}','Rate revision')`);

  const after = await db.query(
    `select billing_month, bill_amount::float8 amt from public.monthly_bills
      where client_id='${rahim}' order by billing_month`);
  check("existing bills still ৳1,000 after the rate change",
    after.rows.length === 3 && after.rows.every((r) => r.amt === 1000),
    JSON.stringify(after.rows.map((r) => r.amt)));

  check("rate effective THIS month is still 1000",
    Number((await one(`select public.client_rate_for_month('${rahim}','${thisMonth}') r`)).r) === 1000);
  check("rate effective NEXT month is 1200",
    Number((await one(`select public.client_rate_for_month('${rahim}','${nextMonth}') r`)).r) === 1200);

  await expectError("cannot back-date a rate into an already-billed month",
    () => db.query(`select public.set_client_rate('${rahim}',900,'${prevMonth}','retro')`),
    "RATE_EFFECTIVE_IN_PAST");

  // Regenerating this month must not re-rate the existing bill either.
  await db.query(`select * from public.generate_monthly_bills('${thisMonth}')`);
  check("re-running generation does not re-rate an existing bill",
    Number((await one(`select bill_amount::float8 a from public.monthly_bills
      where client_id='${rahim}' and billing_month='${thisMonth}'`)).a) === 1000);

  /* ------------------------------------------- TESTS 4/5 still behave */
  console.log("\n== Sections 12/36: the existing adjustment behaviour is untouched ==");
  await db.query(`select public.record_payment('${karim}','${thisMonth}',800,'cash',null,null)`);
  let k = await one(`select adjusted_amount::float8 adj, paid_amount::float8 p, due_amount::float8 d, status
                       from public.monthly_bills where client_id='${karim}' and billing_month='${thisMonth}'`);
  check("Test 4 (short payment): due 200, PARTIAL", k.adj === 1000 && k.p === 800 && k.d === 200 && k.status === "partial",
    JSON.stringify(k));

  const hasanBill = (await one(`select id from public.monthly_bills where client_id='${hasan}' and billing_month='${thisMonth}'`)).id;
  await db.query(`select public.set_bill_adjustment('${hasanBill}',200,'discount','Owner approved')`);
  await db.query(`select public.record_payment('${hasan}','${thisMonth}',1000,'cash',null,null)`);
  const h = await one(`select bill_amount::float8 o, adjusted_amount::float8 adj, paid_amount::float8 p,
                              due_amount::float8 d, status from public.monthly_bills where id='${hasanBill}'`);
  check("Test 5 (discount): original 1200, adjusted 1000, paid 1000, due 0, PAID",
    h.o === 1200 && h.adj === 1000 && h.p === 1000 && h.d === 0 && h.status === "paid", JSON.stringify(h));

  /* ------------------------------------------------ TEST 3: BILL MATRIX */
  console.log("\n== Addendum Test 3: year x month bill history (sections 6-11) ==");
  const year = Number(thisMonth.slice(0, 4));
  const matrix = await db.query(`select * from public.client_bill_matrix('${rahim}', ${year - 1}, ${year})`);
  check("matrix returns this client's bills with year and month broken out",
    matrix.rows.length >= 1 && matrix.rows.every((r) => r.bill_year && r.bill_month >= 1 && r.bill_month <= 12),
    JSON.stringify(matrix.rows.slice(0, 2).map((r) => `${r.bill_year}-${r.bill_month}`)));
  check("matrix carries the full ladder per cell",
    matrix.rows.every((r) => r.bill_amount !== null && r.adjusted_amount !== null && r.due_amount !== null && r.status));

  const years = await db.query(`select * from public.client_bill_years('${rahim}')`);
  check("client_bill_years lists years for the selector",
    years.rows.length >= 1 && years.rows.every((r) => Number.isInteger(r.bill_year)),
    JSON.stringify(years.rows));

  const bounded = await db.query(`select * from public.client_bill_matrix('${rahim}', 1990, 1991)`);
  check("matrix is bounded by the year range (no over-fetching)", bounded.rows.length === 0);

  /* --------------------------------------- TESTS 7/8: AREA FILTER + SUMMARY */
  console.log("\n== Addendum Test 7: area filter (section 20) ==");
  const inArea1 = await db.query(`select * from public.client_month_overview('${thisMonth}','${area1}',null,null,50,0)`);
  const names1 = inArea1.rows.map((r) => r.name).sort();
  check("Area 1 returns only its own clients", JSON.stringify(names1) === JSON.stringify(["Karim", "Rahim"]),
    JSON.stringify(names1));

  const inArea2 = await db.query(`select * from public.client_month_overview('${thisMonth}','${area2}',null,null,50,0)`);
  check("Area 2 returns only Hasan",
    inArea2.rows.length === 1 && inArea2.rows[0].name === "Hasan", JSON.stringify(inArea2.rows.map((r) => r.name)));

  const all = await db.query(`select * from public.client_month_overview('${thisMonth}',null,null,null,50,0)`);
  check("no area filter returns everyone, including the unassigned client",
    all.rows.length === 4 && all.rows.some((r) => r.name === "Nobody"));
  check("client list carries this month's figures (section 24)",
    all.rows.find((r) => r.name === "Karim")?.due_amount !== null &&
    Number(all.rows.find((r) => r.name === "Karim").paid_amount) === 800);
  check("client list reports the area name",
    all.rows.find((r) => r.name === "Rahim")?.area_name === "Area 1");

  const searched = await db.query(`select * from public.client_month_overview('${thisMonth}',null,'Kari',null,50,0)`);
  check("search still works alongside the area filter",
    searched.rows.length === 1 && searched.rows[0].name === "Karim");

  console.log("\n== Addendum Test 8: area financial summary (sections 21, 32) ==");
  const summary = await db.query(`select * from public.area_summary('${thisMonth}')`);
  const a1 = summary.rows.find((r) => r.area_name === "Area 1");
  const a2 = summary.rows.find((r) => r.area_name === "Area 2");
  const un = summary.rows.find((r) => r.area_name === "Unassigned");
  const n = (v) => Number(v);
  console.log(`     Area 1: clients ${a1.client_count} original ${n(a1.original_amount)} adj ${n(a1.adjustment_amount)} adjusted ${n(a1.adjusted_amount)} collected ${n(a1.collected_amount)} due ${n(a1.due_amount)}`);
  console.log(`     Area 2: clients ${a2.client_count} original ${n(a2.original_amount)} adj ${n(a2.adjustment_amount)} adjusted ${n(a2.adjusted_amount)} collected ${n(a2.collected_amount)} due ${n(a2.due_amount)}`);
  check("Area 1: two clients, ৳2,000 billed, ৳800 collected, ৳1,200 due",
    Number(a1.client_count) === 2 && n(a1.original_amount) === 2000 && n(a1.collected_amount) === 800 && n(a1.due_amount) === 1200,
    JSON.stringify(a1));
  check("Area 2: discount reflected - original 1200, adjustment 200, adjusted 1000, due 0",
    n(a2.original_amount) === 1200 && n(a2.adjustment_amount) === 200 && n(a2.adjusted_amount) === 1000 && n(a2.due_amount) === 0,
    JSON.stringify(a2));
  check("every area row satisfies adjusted = original - adjustment",
    summary.rows.every((r) => n(r.original_amount) - n(r.adjustment_amount) === n(r.adjusted_amount)));
  check("every area row satisfies due = adjusted - collected",
    summary.rows.every((r) => n(r.adjusted_amount) - n(r.collected_amount) === n(r.due_amount)));
  check("clients with no area appear as Unassigned rather than vanishing", Boolean(un) && Number(un.client_count) === 1);

  /* ------------------------------------------ TEST 6: AREA-SCOPED DASHBOARD */
  console.log("\n== Addendum Test 6: dashboard, whole business and per area (sections 13-16) ==");
  const whole = (await one(`select public.dashboard_summary('${thisMonth}',null) s`)).s;
  console.log(`     All: original ${n(whole.original_amount)} adj ${n(whole.adjustment_amount)} billed ${n(whole.billed_amount)} collected ${n(whole.collected_amount)} due ${n(whole.due_amount)}`);
  check("dashboard: billed = original - adjustment",
    n(whole.billed_amount) === n(whole.original_amount) - n(whole.adjustment_amount));
  check("dashboard: collected + due = billed",
    n(whole.collected_amount) + n(whole.due_amount) === n(whole.billed_amount));
  check("dashboard reports paid / partial / unpaid counts",
    n(whole.paid_count) + n(whole.partial_count) + n(whole.unpaid_count) === n(whole.bill_count));

  const scoped = (await one(`select public.dashboard_summary('${thisMonth}','${area1}') s`)).s;
  check("area-scoped dashboard matches the area summary row",
    n(scoped.original_amount) === n(a1.original_amount) && n(scoped.due_amount) === n(a1.due_amount),
    `${n(scoped.original_amount)} vs ${n(a1.original_amount)}`);
  check("area-scoped dashboard counts only that area's clients", n(scoped.active_clients) === 2);

  const series = await db.query(`select * from public.monthly_series(3,null)`);
  check("monthly_series exposes original, adjustment and adjusted",
    series.rows.every((r) => n(r.original_amount) - n(r.adjustment_amount) === n(r.billed_amount)));

  const areaSeries = await db.query(`select * from public.monthly_series(3,'${area1}')`);
  check("monthly_series accepts an area filter", areaSeries.rows.length === 3);

  const daily = await db.query(`select * from public.daily_collection_report(current_date,'${area1}')`);
  check("daily report accepts an area filter", Array.isArray(daily.rows));

  /* -------------------------------------------------- SECTION 27: HISTORY */
  console.log("\n== Section 27: moving a client between areas rewrites nothing ==");
  const paymentsBefore = (await one(`select count(*)::int n from public.payments`)).n;
  const billsBefore = (await one(`select coalesce(sum(bill_amount),0)::float8 s from public.monthly_bills`)).s;
  await db.query(`select public.set_client_area('${karim}','${area2}')`);
  check("payments untouched by an area change",
    (await one(`select count(*)::int n from public.payments`)).n === paymentsBefore);
  check("bill amounts untouched by an area change",
    (await one(`select coalesce(sum(bill_amount),0)::float8 s from public.monthly_bills`)).s === billsBefore);
  await db.query(`select public.set_client_area('${karim}','${area1}')`);

  /* ------------------------------------------------------ AUTHORISATION */
  console.log("\n== Section 33: only admins manage areas and rates ==");
  await as(mama);
  await expectError("collector cannot create an area",
    () => db.query(`select public.upsert_area(null,'Sneaky',null,true)`), "ADMIN_ONLY");
  await expectError("collector cannot reassign a client's area",
    () => db.query(`select public.set_client_area('${rahim}','${area2}')`), "ADMIN_ONLY");
  await expectError("collector cannot change a rate",
    () => db.query(`select public.set_client_rate('${rahim}',5,'${nextMonth}','nope')`), "ADMIN_ONLY");
  await expectError("collector cannot read the area summary",
    () => db.query(`select * from public.area_summary('${thisMonth}')`), "ADMIN_ONLY");
  check("collector CAN read the client list (needed to collect)",
    (await db.query(`select * from public.client_month_overview('${thisMonth}',null,null,null,10,0)`)).rows.length === 4);
  check("collector CAN read a bill matrix",
    (await db.query(`select * from public.client_bill_matrix('${rahim}',${year - 1},${year})`)).rows.length >= 1);

  await db.exec(`set role authenticated;`);
  await as(mama);
  const rogue = await db.query(`update public.clients set area_id='${area2}' where id='${rahim}'`);
  check("collector's direct area UPDATE is blocked by RLS", (rogue.affectedRows ?? 0) === 0);
  check("collector cannot read rate history",
    (await db.query(`select count(*)::int n from public.client_rate_history`)).rows[0].n === 0);
  await db.exec(`reset role;`);

  console.log("\n" + "=".repeat(64));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
