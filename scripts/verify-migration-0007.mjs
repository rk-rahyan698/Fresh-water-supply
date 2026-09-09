/**
 * Feature check for 0007 (collection report + client payment history).
 *
 *   npm run verify:reports
 *
 * The important thing proved here is spec section 9: a report cell is money
 * collected in that calendar month, keyed on payment_date. A payment made in
 * April against a March bill belongs to April - it is NOT moved back to the
 * bill's month.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const FILES = [
  "0001_init_schema", "0002_functions", "0003_rls_policies", "0004_bill_adjustments",
  "0005_areas_and_rates", "0006_analytics", "0007_collection_report",
  "0008_normalize_3nf",
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
    if (!token || m.includes(token)) { pass++; console.log(`  PASS  ${name} -> ${m.split("\n")[0].slice(0, 50)}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name} (wrong error: ${m.split("\n")[0]})`); }
  }
}

const as = (id) => db.exec(`select set_config('app.current_user_id', '${id ?? ""}', false);`);
const one = async (q) => (await db.query(q)).rows[0];
const n = (v) => Number(v);

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

  const abbu = randomUUID(), mama = randomUUID(), jamal = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}'),
    ('${jamal}','jamal@t.test','{"full_name":"Jamal","role":"collector"}');`);
  await as(abbu);

  // A fixed historical year keeps the assertions stable whenever this runs.
  const YEAR = 2024;
  const mkArea = async (nm) => (await one(`select (public.upsert_area(null,'${nm}',null,true)).id id`)).id;
  const area1 = await mkArea("Area 1");
  const area2 = await mkArea("Area 2");

  const mk = async (code, nm, amt, area) => (await one(
    `select (public.upsert_client(null,'${code}','${nm}',null,null,${amt},'${YEAR}-01-01','active',null,'${area}')).id id`)).id;
  const rahim = await mk("C-1", "Rahim", 1000, area1);
  const karim = await mk("C-2", "Karim", 1000, area1);
  const hasan = await mk("C-3", "Hasan", 1000, area2);
  await mk("C-4", "Quiet Client", 1000, area1); // never pays - must still appear as 0

  // Bills for Mar and Apr of that year.
  for (const m of [`${YEAR}-03-01`, `${YEAR}-04-01`]) {
    await db.query(`select * from public.generate_monthly_bills('${m}')`);
  }

  /* ------------------------------------------------- SECTION 9: the key rule */
  console.log("\n== Section 9: a cell is money collected THAT month, by payment date ==");
  console.log("   Rahim: March bill 1000 -> pays 800 in March, then 200 in APRIL");
  await as(mama);
  await db.query(`select public.record_payment('${rahim}','${YEAR}-03-01',800,'cash',null,'${YEAR}-03-20')`);
  await db.query(`select public.record_payment('${rahim}','${YEAR}-03-01',200,'cash',null,'${YEAR}-04-05')`);

  await as(abbu);
  const matrix = await db.query(`select * from public.collection_matrix(${YEAR}, null, null)`);
  const r = matrix.rows.find((row) => row.client_name === "Rahim");
  console.log(`     Rahim: Mar ${n(r.m03)}  Apr ${n(r.m04)}  total ${n(r.year_total)}`);
  check("March cell shows 800 (paid in March)", n(r.m03) === 800, `got ${n(r.m03)}`);
  check("April cell shows 200 - NOT moved back to the March bill", n(r.m04) === 200, `got ${n(r.m04)}`);
  check("year total is 1000 across both months", n(r.year_total) === 1000);
  check("the March BILL is still fully paid",
    n((await one(`select paid_amount::float8 p from public.monthly_bills
                   where client_id='${rahim}' and billing_month='${YEAR}-03-01'`)).p) === 1000);

  /* ------------------------------------------------------ zero-payment rows */
  console.log("\n== Section 18: clients with no payments appear as 0, not missing ==");
  const q = matrix.rows.find((row) => row.client_name === "Quiet Client");
  check("client who never paid is still a row", Boolean(q), "row missing entirely");
  check("their cells are 0, not null", q && n(q.m03) === 0 && n(q.year_total) === 0,
    q ? `m03=${q.m03} total=${q.year_total}` : "");
  check("all twelve months present for every row",
    matrix.rows.every((row) => [row.m01, row.m02, row.m03, row.m04, row.m05, row.m06,
      row.m07, row.m08, row.m09, row.m10, row.m11, row.m12].every((v) => v !== null)));

  /* -------------------------------------------------------------- totals */
  console.log("\n== Sections 6-8: matrix and totals ==");
  await as(mama);
  await db.query(`select public.record_payment('${karim}','${YEAR}-03-01',1000,'cash',null,'${YEAR}-03-15')`);
  await as(jamal);
  await db.query(`select public.record_payment('${hasan}','${YEAR}-04-01',600,'cash',null,'${YEAR}-04-10')`);

  await as(abbu);
  const m2 = await db.query(`select * from public.collection_matrix(${YEAR}, null, null)`);
  const marchTotal = m2.rows.reduce((s, row) => s + n(row.m03), 0);
  const aprilTotal = m2.rows.reduce((s, row) => s + n(row.m04), 0);
  const grand = m2.rows.reduce((s, row) => s + n(row.year_total), 0);
  console.log(`     March ${marchTotal} | April ${aprilTotal} | grand ${grand}`);
  check("March column total = 1800 (800 + 1000)", marchTotal === 1800);
  check("April column total = 800 (200 + 600)", aprilTotal === 800);
  check("grand total = sum of every month", grand === marchTotal + aprilTotal);
  check("four client rows returned", m2.rows.length === 4);

  /* --------------------------------------------------------- year selector */
  console.log("\n== Section 10: years come from the data ==");
  const years = await db.query(`select * from public.payment_years()`);
  check("payment_years lists the year with payments",
    years.rows.some((row) => n(row.payment_year) === YEAR), JSON.stringify(years.rows));
  const otherYear = await db.query(`select * from public.collection_matrix(${YEAR - 1}, null, null)`);
  check("a year with no payments returns all-zero rows",
    otherYear.rows.length === 4 && otherYear.rows.every((row) => n(row.year_total) === 0));

  /* ------------------------------------------------------------- filters */
  console.log("\n== Sections 11, 16: area and collector filters ==");
  const byArea = await db.query(`select * from public.collection_matrix(${YEAR}, '${area1}', null)`);
  check("area filter returns only that area's clients",
    byArea.rows.length === 3 && byArea.rows.every((row) => row.area_name === "Area 1"),
    JSON.stringify(byArea.rows.map((row) => row.client_name)));
  check("area filter excludes the other area's money",
    byArea.rows.reduce((s, row) => s + n(row.year_total), 0) === 2000);

  const byCollector = await db.query(`select * from public.collection_matrix(${YEAR}, null, '${jamal}')`);
  const jamalTotal = byCollector.rows.reduce((s, row) => s + n(row.year_total), 0);
  check("collector filter counts only that collector's payments", jamalTotal === 600, `got ${jamalTotal}`);
  check("collector filter still lists every client (0 where they did not pay)",
    byCollector.rows.length === 4);

  const combined = await db.query(`select * from public.collection_matrix(${YEAR}, '${area1}', '${mama}')`);
  check("area + collector combine (section 23)",
    combined.rows.reduce((s, row) => s + n(row.year_total), 0) === 2000 && combined.rows.length === 3);

  /* -------------------------------------------------------------- summary */
  console.log("\n== Sections 13, 14: summary cards ==");
  const sum = (await one(`select public.collection_summary(${YEAR}, null, null) s`)).s;
  console.log(`     collected ${n(sum.total_collected)} | payments ${n(sum.payment_count)} | original ${n(sum.original_amount)} | adjusted ${n(sum.adjusted_amount)} | outstanding ${n(sum.outstanding)}`);
  check("summary collected matches the matrix grand total", n(sum.total_collected) === grand);
  check("summary payment count is right", n(sum.payment_count) === 4);
  check("average payment = collected / count", n(sum.average_payment) === Math.round((grand / 4) * 100) / 100);
  check("bill ladder: adjusted = original - adjustment",
    n(sum.adjusted_amount) === n(sum.original_amount) - n(sum.adjustment_amount));
  check("bill ladder: collected + outstanding = adjusted",
    n(sum.billed_collected) + n(sum.outstanding) === n(sum.adjusted_amount));

  // An adjustment must show up in the summary without touching collections.
  const hasanApril = (await one(`select id from public.monthly_bills
    where client_id='${hasan}' and billing_month='${YEAR}-04-01'`)).id;
  await db.query(`select public.set_bill_adjustment('${hasanApril}',400,'discount','Owner approved')`);
  const sum2 = (await one(`select public.collection_summary(${YEAR}, null, null) s`)).s;
  check("adjustment appears in the summary", n(sum2.adjustment_amount) === 400);
  check("adjustment does NOT change money collected", n(sum2.total_collected) === grand);
  check("adjusted bills drop by the adjustment",
    n(sum2.adjusted_amount) === n(sum.original_amount) - 400);
  check("Hasan now settled: 600 paid against a 600 adjusted bill",
    n((await one(`select due_amount::float8 d from public.monthly_bills where id='${hasanApril}'`)).d) === 0);

  const areaSum = (await one(`select public.collection_summary(${YEAR}, '${area1}', null) s`)).s;
  check("summary respects the area filter", n(areaSum.total_collected) === 2000);

  /* ----------------------------------------------- client payment history */
  console.log("\n== Sections 2C, 3: one client's payment history ==");
  const hist = await db.query(`select * from public.client_payment_history('${rahim}', null, 500)`);
  check("both of Rahim's payments returned", hist.rows.length === 2);
  check("newest first", hist.rows[0].payment_date >= hist.rows[1].payment_date);
  check("history carries billing month, collector and reference",
    hist.rows.every((row) => row.billing_month && row.collector_name === "Mama" && row.receipt_no));

  const byYear = await db.query(`select * from public.client_payment_history('${rahim}', ${YEAR - 1}, 500)`);
  check("year filter narrows the history", byYear.rows.length === 0);

  const cSum = (await one(`select public.client_financial_summary('${rahim}', null) s`)).s;
  check("client summary: paid 1000 of a 2000 original across two bills",
    n(cSum.paid_in_period) === 1000 && n(cSum.original_amount) === 2000, JSON.stringify(cSum));
  check("client summary: outstanding = adjusted - collected",
    n(cSum.adjusted_amount) - n(cSum.collected_amount) === n(cSum.outstanding));

  /* -------------------------------------------------------- authorisation */
  console.log("\n== Section 23: permissions ==");
  await as(mama);
  await expectError("collector cannot open the all-client matrix",
    () => db.query(`select * from public.collection_matrix(${YEAR}, null, null)`), "ADMIN_ONLY");
  await expectError("collector cannot read the collection summary",
    () => db.query(`select public.collection_summary(${YEAR}, null, null)`), "ADMIN_ONLY");
  await expectError("collector cannot list payment years",
    () => db.query(`select * from public.payment_years()`), "ADMIN_ONLY");

  const mamaHist = await db.query(`select * from public.client_payment_history('${hasan}', null, 500)`);
  check("collector sees only payments THEY took on a client",
    mamaHist.rows.length === 0, `saw ${mamaHist.rows.length} of Jamal's payments`);

  const jamalSees = await (async () => { await as(jamal);
    return db.query(`select * from public.client_payment_history('${hasan}', null, 500)`); })();
  check("the collector who took the payment does see it", jamalSees.rows.length === 1);

  await as(abbu);
  const adminSees = await db.query(`select * from public.client_payment_history('${hasan}', null, 500)`);
  check("admin sees every payment on the client", adminSees.rows.length === 1);

  console.log("\n" + "=".repeat(64));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
