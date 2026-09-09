/**
 * Migration-path check for 0008_normalize_3nf.sql.
 *
 *   npm run verify:3nf
 *
 * Applies 0001-0007, seeds a database that looks like a real one (clients,
 * bills across several months, payments, a scheduled rate change), and only
 * THEN applies 0008 - so the backfill is exercised against data rather than
 * against an empty schema.
 *
 * What it proves:
 *
 *   1. The two redundant columns are gone.
 *   2. Nothing was lost: bill count, payment count and collected totals are
 *      identical either side of the migration.
 *   3. The anomaly that motivated the work is fixed - a rate scheduled for a
 *      future month is the rate that month is billed at, and the figure the
 *      UI reads can no longer disagree with it.
 *   4. Every report that used to read payments.client_id still returns the
 *      same numbers now that it reaches the client through the bill.
 *   5. Re-running 0008 changes nothing.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const BASE = [
  "0001_init_schema", "0002_functions", "0003_rls_policies", "0004_bill_adjustments",
  "0005_areas_and_rates", "0006_analytics", "0007_collection_report",
];

const db = new PGlite({ extensions: { pg_trgm } });
let pass = 0, fail = 0;
const failures = [];

const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};

const sql = (f) => readFileSync(join(MIGRATIONS, `${f}.sql`), "utf8");
const one = async (q) => (await db.query(q)).rows[0];
const rows = async (q) => (await db.query(q)).rows;
const as = (id) => db.exec(`select set_config('app.current_user_id', '${id ?? ""}', false);`);
const n = (v) => Number(v ?? 0);
const ds = (v) => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v).slice(0, 10);
const shift = (m, k) => {
  const [y, mm] = m.split("-").map(Number);
  const t = y * 12 + (mm - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
};

const hasColumn = async (table, column) =>
  (await rows(`select 1 from information_schema.columns
                where table_schema='public' and table_name='${table}' and column_name='${column}'`)).length > 0;

async function expectError(name, fn, fragment) {
  try { await fn(); check(name, false, "no error raised"); }
  catch (e) { check(name, String(e.message).includes(fragment), `got: ${e.message}`); }
}

async function main() {
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);

  console.log("== Applying 0001-0007 ==");
  for (const f of BASE) await db.exec(sql(f));
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  const abbu = randomUUID(), mama = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}');`);
  await as(abbu);

  const thisMonth = ds((await one(`select public.dhaka_current_month() m`)).m);
  const prev1 = shift(thisMonth, -1);
  const prev2 = shift(thisMonth, -2);
  const next = shift(thisMonth, 1);

  /* ------------------------------------------------------- seed, pre-0008 */
  console.log("\n== Seeding a populated database (pre-0008) ==");
  const area = (await one(`select (public.upsert_area(null,'Mirpur','side',true)).id id`)).id;
  const mk = async (code, name, amt) => (await one(
    `select (public.upsert_client(null,'${code}','${name}',null,null,${amt},'${prev2}','active',null,'${area}')).id id`)).id;

  const rahim = await mk("C-1", "Rahim", 1000);
  const karim = await mk("C-2", "Karim", 800);
  const hasan = await mk("C-3", "Hasan", 1200);

  for (const m of [prev2, prev1, thisMonth]) {
    await db.query(`select * from public.generate_monthly_bills('${m}')`);
  }
  await as(mama);
  await db.query(`select public.record_payment('${rahim}','${prev2}',1000,'cash',null,'${prev2}')`);
  await db.query(`select public.record_payment('${karim}','${prev1}',500,'cash',null,'${prev1}')`);
  await as(abbu);
  await db.query(`select public.record_payment('${hasan}','${thisMonth}',600,'bank',null,null)`);

  const before = {
    bills: n((await one(`select count(*)::int c from public.monthly_bills`)).c),
    payments: n((await one(`select count(*)::int c from public.payments`)).c),
    collected: n((await one(`select coalesce(sum(amount),0)::float8 s from public.payments where voided_at is null`)).s),
    billed: n((await one(`select coalesce(sum(bill_amount),0)::float8 s from public.monthly_bills`)).s),
    paidCache: n((await one(`select coalesce(sum(paid_amount),0)::float8 s from public.monthly_bills`)).s),
  };
  console.log(`   seeded: ${before.bills} bills, ${before.payments} payments, ` +
              `${before.billed} billed, ${before.collected} collected`);

  // The anomaly, reproduced on the OLD schema so the fix has something to fix.
  await db.query(`select public.set_client_rate('${rahim}', 1500, '${next}', 'Annual increase')`);
  const staleColumn = n((await one(`select monthly_bill::float8 m from public.clients where id='${rahim}'`)).m);
  const realRate = n((await one(`select public.client_rate_for_month('${rahim}','${next}')::float8 r`)).r);
  check("PRE-0008: clients.monthly_bill disagrees with the scheduled rate (the bug)",
    staleColumn === 1000 && realRate === 1500, `column=${staleColumn} rate=${realRate}`);

  /* ------------------------------------------------------------ apply 0008 */
  console.log("\n== Applying 0008 on the populated database ==");
  await db.exec(sql("0008_normalize_3nf"));
  console.log("   applied 0008_normalize_3nf.sql");

  console.log("\n== The redundant columns are gone ==");
  check("clients.monthly_bill dropped", !(await hasColumn("clients", "monthly_bill")));
  check("payments.client_id dropped", !(await hasColumn("payments", "client_id")));
  check("client_rate_history survives as the rate authority",
    await hasColumn("client_rate_history", "monthly_bill"));
  check("monthly_bills.client_id kept - a bill genuinely belongs to a client",
    await hasColumn("monthly_bills", "client_id"));

  console.log("\n== Nothing was lost ==");
  const after = {
    bills: n((await one(`select count(*)::int c from public.monthly_bills`)).c),
    payments: n((await one(`select count(*)::int c from public.payments`)).c),
    collected: n((await one(`select coalesce(sum(amount),0)::float8 s from public.payments where voided_at is null`)).s),
    billed: n((await one(`select coalesce(sum(bill_amount),0)::float8 s from public.monthly_bills`)).s),
    paidCache: n((await one(`select coalesce(sum(paid_amount),0)::float8 s from public.monthly_bills`)).s),
  };
  check("bill count unchanged", before.bills === after.bills, `${before.bills} -> ${after.bills}`);
  check("payment count unchanged", before.payments === after.payments, `${before.payments} -> ${after.payments}`);
  check("collected total unchanged", before.collected === after.collected, `${before.collected} -> ${after.collected}`);
  check("billed total unchanged", before.billed === after.billed, `${before.billed} -> ${after.billed}`);
  check("paid_amount cache unchanged", before.paidCache === after.paidCache, `${before.paidCache} -> ${after.paidCache}`);

  console.log("\n== Every client got an opening rate at their start month ==");
  const orphans = await rows(`select c.client_code from public.clients c
     where not exists (select 1 from public.client_rate_history h
                        where h.client_id = c.id
                          and h.effective_from <= date_trunc('month', c.start_date)::date)`);
  check("no client is left without a rate for their first billable month",
    orphans.length === 0, orphans.map((r) => r.client_code).join(","));
  check("the opening rate is the rate they were created with",
    n((await one(`select public.client_rate_for_month('${karim}','${prev2}')::float8 r`)).r) === 800);

  console.log("\n== THE ANOMALY IS FIXED ==");
  const nowRate = n((await one(`select public.client_current_rate('${rahim}')::float8 r`)).r);
  const nextRate = n((await one(`select public.client_rate_for_month('${rahim}','${next}')::float8 r`)).r);
  const computed = n((await one(`select public.monthly_bill(c)::float8 r from public.clients c where c.id='${rahim}'`)).r);
  check("this month still bills at the old rate", nowRate === 1000, String(nowRate));
  check("next month bills at the scheduled rate", nextRate === 1500, String(nextRate));
  check("the figure the UI reads IS the figure billing uses", computed === nowRate,
    `computed=${computed} current=${nowRate}`);

  // Prove it end to end: generate next month's bill and read the amount.
  await db.exec(`create or replace function public.dhaka_current_month() returns date
                 language sql stable as $fn$ select '${next}'::date $fn$;`);
  await db.query(`select * from public.generate_monthly_bills('${next}')`);
  const nextBill = n((await one(`select bill_amount::float8 a from public.monthly_bills
                                  where client_id='${rahim}' and billing_month='${next}'`)).a);
  const nextComputed = n((await one(`select public.monthly_bill(c)::float8 r from public.clients c where c.id='${rahim}'`)).r);
  check("next month's generated bill is 1500", nextBill === 1500, String(nextBill));
  check("and the UI figure has followed it, with nobody re-saving the client",
    nextComputed === 1500, String(nextComputed));
  await db.exec(`create or replace function public.dhaka_current_month() returns date
                 language sql stable as $fn$ select date_trunc('month', (now() at time zone 'Asia/Dhaka'))::date $fn$;`);
  await db.query(`delete from public.monthly_bills where billing_month='${next}'`);

  console.log("\n== Reports still reach the client through the bill ==");
  const hist = await rows(`select * from public.client_payment_history('${rahim}', null, 50)`);
  check("client_payment_history finds Rahim's payment", hist.length === 1 && n(hist[0].amount) === 1000,
    JSON.stringify(hist.map((r) => r.amount)));
  const noneForHasanUnderRahim = hist.every((r) => n(r.amount) !== 600);
  check("and does not leak another client's payment into it", noneForHasanUnderRahim);

  const fin = (await one(`select public.client_financial_summary('${karim}', null) s`)).s;
  check("client_financial_summary sums only that client", n(fin.paid_in_period) === 500,
    JSON.stringify(fin));

  const dash = (await one(`select public.dashboard_summary('${thisMonth}', null) d`)).d;
  check("dashboard: collected + due = billed",
    n(dash.collected_amount) + n(dash.due_amount) === n(dash.billed_amount),
    JSON.stringify({ c: dash.collected_amount, d: dash.due_amount, b: dash.billed_amount }));
  check("dashboard month cash flow still counts the month's payment",
    n(dash.received_in_month) === 600, String(dash.received_in_month));

  const dashArea = (await one(`select public.dashboard_summary('${thisMonth}', '${area}') d`)).d;
  check("area-scoped dashboard reaches the area through the bill",
    n(dashArea.received_in_month) === 600, String(dashArea.received_in_month));

  const matrix = await rows(`select client_code, year_total::float8 t, payment_count::int c
                               from public.collection_matrix(extract(year from current_date)::int, null, null)`);
  check("collection_matrix returns a row per client, zeros included",
    matrix.length === 3, String(matrix.length));
  check("collection_matrix totals match the payments",
    matrix.reduce((s, r) => s + n(r.t), 0) === before.collected,
    JSON.stringify(matrix.map((r) => `${r.client_code}=${r.t}`)));

  const summary = (await one(`select public.collection_summary(extract(year from current_date)::int, null, null) s`)).s;
  check("collection_summary total matches", n(summary.total_collected) === before.collected,
    String(summary.total_collected));
  check("collection_summary counts distinct paying clients off the bill",
    n(summary.paying_clients) === 3, String(summary.paying_clients));

  const daily = await rows(`select * from public.daily_collection_report(public.dhaka_today(), null)`);
  check("daily_collection_report still groups by collector", daily.length === 1, String(daily.length));
  const dailyArea = await rows(`select * from public.daily_collection_report(public.dhaka_today(), '${area}')`);
  check("daily_collection_report area filter joins through the bill",
    dailyArea.length === 1, String(dailyArea.length));

  const series = await rows(`select * from public.collector_series('${prev2}', public.dhaka_today(), '${area}')`);
  check("collector_series area filter joins through the bill",
    series.reduce((s, r) => s + n(r.total_amount), 0) === before.collected,
    JSON.stringify(series.map((r) => r.total_amount)));

  const overview = await rows(`select client_code, monthly_bill::float8 r, bill_amount::float8 b
                                 from public.client_month_overview('${thisMonth}', null, null, null, 25, 0)`);
  check("client_month_overview reports the rate for the month being viewed",
    overview.length === 3 && overview.every((r) => r.r !== null), JSON.stringify(overview));

  console.log("\n== Guards still hold ==");
  await expectError("a client with payments cannot be deleted",
    () => db.query(`select public.delete_client('${rahim}')`), "CLIENT_HAS_PAYMENTS");
  await expectError("payments are still undeletable",
    () => db.query(`delete from public.payments`), "PAYMENT_DELETE_FORBIDDEN");
  await expectError("a payment's bill still cannot be moved",
    () => db.query(`update public.payments set monthly_bill_id = gen_random_uuid()`), "PAYMENT_IMMUTABLE");
  await expectError("a rate cannot be back-dated into a billed month",
    () => db.query(`select public.set_client_rate('${rahim}', 900, '${prev1}', 'nope')`), "RATE_EFFECTIVE_IN_PAST");

  await as(mama);
  await expectError("a collector still cannot change a rate",
    () => db.query(`select public.set_client_rate('${rahim}', 900, '${next}', 'nope')`), "ADMIN_ONLY");
  await as(abbu);

  console.log("\n== A client with no history at all is still deletable ==");
  const ghost = await mk("C-9", "Ghost", 100);
  await db.query(`select public.delete_client('${ghost}')`);
  check("delete_client removed the client",
    n((await one(`select count(*)::int c from public.clients where id='${ghost}'`)).c) === 0);
  check("and their rate rows went with them (ON DELETE CASCADE)",
    n((await one(`select count(*)::int c from public.client_rate_history where client_id='${ghost}'`)).c) === 0);

  console.log("\n== Re-running 0008 is safe ==");
  await db.exec(sql("0008_normalize_3nf"));
  const rerun = {
    bills: n((await one(`select count(*)::int c from public.monthly_bills`)).c),
    payments: n((await one(`select count(*)::int c from public.payments`)).c),
    collected: n((await one(`select coalesce(sum(amount),0)::float8 s from public.payments where voided_at is null`)).s),
    rates: n((await one(`select count(*)::int c from public.client_rate_history`)).c),
  };
  const ratesBefore = rerun.rates;
  await db.exec(sql("0008_normalize_3nf"));
  check("idempotent: bills unchanged", rerun.bills === after.bills);
  check("idempotent: payments unchanged", rerun.payments === after.payments);
  check("idempotent: collected unchanged", rerun.collected === after.collected);
  check("idempotent: no duplicate rate rows",
    n((await one(`select count(*)::int c from public.client_rate_history`)).c) === ratesBefore);

  console.log("\n== A brand-new client still gets exactly one opening rate ==");
  const fresh = await mk("C-10", "Fresh", 777);
  const freshRates = await rows(`select effective_from, monthly_bill::float8 m
                                   from public.client_rate_history where client_id='${fresh}'`);
  check("one rate row, at the start month", freshRates.length === 1, JSON.stringify(freshRates));
  check("and it is the amount the form supplied", n(freshRates[0]?.m) === 777);

  console.log("\n== Editing a client only writes a rate row when the rate moved ==");
  await db.query(`select public.upsert_client('${fresh}','C-10','Fresh Renamed','017','addr',777,'${prev2}','active',null,'${area}')`);
  check("unrelated edit added no rate row",
    (await rows(`select 1 from public.client_rate_history where client_id='${fresh}'`)).length === 1);
  await db.query(`select public.upsert_client('${fresh}','C-10','Fresh Renamed','017','addr',999,'${prev2}','active',null,'${area}')`);
  check("changing the rate did add one, effective this month",
    (await rows(`select 1 from public.client_rate_history where client_id='${fresh}'`)).length === 2);
  check("and the current rate now reads 999",
    n((await one(`select public.client_current_rate('${fresh}')::float8 r`)).r) === 999);
  check("while the already-billed past keeps the old rate",
    n((await one(`select public.client_rate_for_month('${fresh}','${prev2}')::float8 r`)).r) === 777);

  const line = "=".repeat(64);
  console.log(`\n${line}\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log(`Failed: ${failures.join(", ")}`);
  console.log(line);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
