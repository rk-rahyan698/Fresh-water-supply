/**
 * Verifies 0011_collection_matrix_by_bill.sql.
 *
 *   npm run verify:bybill
 *
 * The collection report used to file every payment under the month it was
 * RECEIVED. A client owing August and September who paid both on 11 September
 * showed AUG 0 / SEP 1,000 - reading as "August unpaid" when the ledger had
 * both months PAID. This proves the by-billing-month view:
 *
 *   1. Reproduces that case from the old function, then shows the new one
 *      reading AUG 500 / SEP 500.
 *   2. Shows what is still due, so "billed and unpaid" and "not billed" never
 *      look alike, and a partial month says how much is left.
 *   3. Files a January payment for December under December of the bill's year.
 *   4. Excludes voided payments, respects the collector and area filters, and
 *      lists every client just like the payment-date view.
 *   5. Adds up to the same billed-collected and outstanding figures the
 *      report's summary cards already show.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, "..", "supabase", "migrations");
const SETUP = join(here, "..", "supabase", "setup.sql");
const ALL = [
  "0001_init_schema", "0002_functions", "0003_rls_policies", "0004_bill_adjustments",
  "0005_areas_and_rates", "0006_analytics", "0007_collection_report", "0008_normalize_3nf",
  "0009_server_side_totals", "0010_multi_month_collection", "0011_collection_matrix_by_bill",
];

const { allocateOldestFirst, billCellState } = await import(
  "file://" + join(here, "..", "src", "lib", "collection-math.ts")
);

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
const n = (v) => (v === null || v === undefined ? null : Number(v));
async function expectError(name, fn, fragment) {
  try { await fn(); check(name, false, "no error raised"); }
  catch (e) { check(name, String(e.message).includes(fragment), `got: ${e.message}`); }
}

async function main() {
  /* ------------------------------------------------------------- cell state */
  console.log("== Cell state (src/lib/collection-math.ts) ==");
  check("no bill -> none", billCellState(null, null) === "none");
  check("billed, nothing paid -> unpaid", billCellState(0, 500) === "unpaid");
  check("some paid, some owed -> partial", billCellState(400, 100) === "partial");
  check("nothing owed -> paid", billCellState(500, 0) === "paid");
  check("settled by ANOTHER collector (paid 0 under a filter, due 0) -> still paid",
    billCellState(0, 0) === "paid");
  check("paisa: 0.001 due rounds to settled", billCellState(500, 0.001) === "paid");

  /* ----------------------------------------------------------------- PDF */
  console.log("\n== The by-bill PDF still fits the page with 'due' lines ==");
  {
    // autoTable reports overflow through console.log ("N units width could
    // not fit page"). Intercept it, prove the detector fires on an oversized
    // table, then check the real layout: every month a worst-case two-line
    // cell ("12,000" / "due 12,000").
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const warnings = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args) => {
      const line = args.join(" ");
      if (/could not fit|overflow/i.test(line)) warnings.push(line); else original.log(...args);
    };
    const table = (widths) => {
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      autoTable(doc, {
        startY: 160, margin: { left: 40, right: 40 },
        head: [["Client", "Area", "Monthly bill", ...MONTHS, "Total"]],
        body: [["Mohammad Rahimuddin\nWS-0001", "Mirpur Section 10", "1,000 Jan-Jun\n1,200 Jul-Dec",
          ...MONTHS.map(() => "12,000\ndue 12,000"), "144,000\ndue 144,000"]],
        foot: [["TOTAL", "", "", ...MONTHS.map(() => "999,999"), "9,999,999\ndue 9,999,999"]],
        styles: { font: "helvetica", fontSize: 7, cellPadding: 3 },
        headStyles: { fontSize: 7 },
        columnStyles: widths,
      });
      return doc.output("arraybuffer").byteLength;
    };
    console.log = console.warn = console.error = capture;
    try { table({ 0: { cellWidth: 300 }, 1: { cellWidth: 200 }, 2: { cellWidth: 200 } }); }
    finally { Object.assign(console, original); }
    check("the overflow detector catches a table that is too wide", warnings.length > 0);
    warnings.length = 0;

    let bytes = 0;
    console.log = console.warn = console.error = capture;
    try { bytes = table({ 0: { cellWidth: 86 }, 1: { cellWidth: 50 }, 2: { cellWidth: 68 } }); }
    finally { Object.assign(console, original); }
    check("real layout with worst-case due lines fits landscape A4", warnings.length === 0, warnings.join(" | "));
    check("and produces a PDF", bytes > 1000);
  }

  /* ---------------------------------------------------------------- schema */
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);

  console.log("\n== Applying 0001-0011 ==");
  for (const f of ALL) {
    try { await db.exec(sql(f)); check(`${f} applied`, true); }
    catch (e) { check(`${f} applied`, false, e.message); }
  }
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  for (const fn of ["collection_matrix_by_bill", "collection_report_years"]) {
    const r = await one(`select bool_or(has_function_privilege('anon', p.oid, 'execute')) a,
        bool_or(has_function_privilege('authenticated', p.oid, 'execute')) au
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='${fn}'`);
    check(`${fn}(): anon denied, authenticated allowed`, r.a === false && r.au === true);
  }

  const abbu = randomUUID(), mama = randomUUID(), jamal = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}'),
    ('${jamal}','jamal@t.test','{"full_name":"Jamal","role":"collector"}');`);
  await as(abbu);

  // A whole past year, so every date below is legal (no future payments) and
  // nothing straddles today.
  const today = String((await one(`select public.dhaka_today()::text d`)).d);
  const YEAR = Number(today.slice(0, 4)) - 1;
  const m = (month) => `${YEAR}-${String(month).padStart(2, "0")}-01`;
  const onDay = (month, day) => `${YEAR}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const area = (await one(`select (public.upsert_area(null,'Dhanmondi','s',true)).id id`)).id;
  const mk = async (code, name, amt, start = m(8), areaId = area) => (await one(
    `select (public.upsert_client(null,'${code}','${name}',null,null,${amt},'${start}','active',null,${areaId ? `'${areaId}'` : "null"})).id id`)).id;

  const khan = await mk("WS-0092", "Abdul Khan", 500);
  const molla = await mk("WS-0050", "Abdul Molla", 500);
  const nobody = await mk("WS-0091", "Abdul Islam", 700, m(8), null);   // billed, never pays, no area
  const late = await mk("WS-0100", "Late Starter", 400, m(12));
  for (let k = 8; k <= 12; k++) await db.query(`select * from public.generate_monthly_bills('${m(k)}')`);

  const collect = (clientId, allocations, date) => rows(`select * from public.record_collection('${clientId}',
    '${JSON.stringify(allocations)}'::jsonb, 'cash', null, '${date}')`);
  const byBill = async (collector = null, areaId = null, year = YEAR) =>
    Object.fromEntries((await rows(`select * from public.collection_matrix_by_bill(${year},
      ${areaId ? `'${areaId}'` : "null"}, ${collector ? `'${collector}'` : "null"})`))
      .map((r) => [r.client_id, {
        paid: r.paid_amounts.map(n), due: r.due_amounts.map(n),
        total: n(r.year_total), yearDue: n(r.year_due), count: Number(r.payment_count),
      }]));
  const byDate = async (year = YEAR) =>
    Object.fromEntries((await rows(`select * from public.collection_matrix(${year}, null, null)`))
      .map((r) => [r.client_id, [r.m01, r.m02, r.m03, r.m04, r.m05, r.m06, r.m07, r.m08, r.m09, r.m10, r.m11, r.m12].map(Number)]));

  /* ---------------------------------------------------- the reported case */
  console.log("\n== The reported case: Abdul Khan pays Aug + Sep on 11 September ==");
  await as(mama);
  const khanSplit = allocateOldestFirst([{ billing_month: m(8), due: 500 }, { billing_month: m(9), due: 500 }], 1000);
  await collect(khan, khanSplit.allocations, onDay(9, 11));

  await as(abbu);
  const oldView = (await byDate())[khan];
  check("REPRODUCED - by payment date: AUG 0, SEP 1,000 (looks like August is unpaid)",
    oldView[7] === 0 && oldView[8] === 1000, JSON.stringify(oldView.slice(7, 9)));

  const khanRow = (await byBill())[khan];
  check("by billing month: AUG 500, SEP 500", khanRow.paid[7] === 500 && khanRow.paid[8] === 500,
    JSON.stringify(khanRow.paid.slice(7, 9)));
  check("...both with nothing due", khanRow.due[7] === 0 && khanRow.due[8] === 0);
  check("...and both read as PAID", billCellState(khanRow.paid[7], khanRow.due[7]) === "paid"
    && billCellState(khanRow.paid[8], khanRow.due[8]) === "paid");
  check("year total is still 1,000 either way", khanRow.total === 1000 && oldView.reduce((a, b) => a + b, 0) === 1000);

  /* -------------------------------------------------------- the 900 example */
  console.log("\n== The 900 example: owes Aug + Sep, pays 900 ==");
  await as(mama);
  const mollaSplit = allocateOldestFirst([{ billing_month: m(8), due: 500 }, { billing_month: m(9), due: 500 }], 900);
  await collect(molla, mollaSplit.allocations, onDay(9, 20));
  await as(abbu);
  const mollaRow = (await byBill())[molla];
  check("AUG 500 paid, nothing due", mollaRow.paid[7] === 500 && mollaRow.due[7] === 0);
  check("SEP 400 paid, 100 still due", mollaRow.paid[8] === 400 && mollaRow.due[8] === 100,
    JSON.stringify({ paid: mollaRow.paid[8], due: mollaRow.due[8] }));
  check("SEP reads as PARTIAL, not paid", billCellState(mollaRow.paid[8], mollaRow.due[8]) === "partial");
  check("OCT-DEC: billed, unpaid, 500 due each",
    [9, 10, 11].every((i) => mollaRow.paid[i] === 0 && mollaRow.due[i] === 500));

  /* ------------------------------------------------- none vs unpaid vs paid */
  console.log("\n== 'Not billed' never looks like 'unpaid' ==");
  const lateRow = (await byBill())[late];
  check("months before the client started are NULL (no bill), not 0",
    lateRow.paid.slice(0, 11).every((v) => v === null) && lateRow.due.slice(0, 11).every((v) => v === null));
  check("its one billed month is 0 paid with 400 due -> UNPAID",
    lateRow.paid[11] === 0 && lateRow.due[11] === 400 && billCellState(lateRow.paid[11], lateRow.due[11]) === "unpaid");
  const nobodyRow = (await byBill())[nobody];
  check("a client who never paid still gets a row, with year_due = everything billed",
    nobodyRow && nobodyRow.total === 0 && nobodyRow.yearDue === 700 * 5, JSON.stringify(nobodyRow));

  /* ----------------------------------------------- January pays December */
  console.log("\n== A January payment for December ==");
  await as(jamal);
  const janDate = [`${YEAR + 1}-01-10`, today].sort()[0];   // never in the future
  await collect(late, [{ billing_month: m(12), amount: 400 }], janDate);
  await as(abbu);
  const lateAfter = (await byBill())[late];
  check(`counts under DECEMBER ${YEAR} by billing month`, lateAfter.paid[11] === 400 && lateAfter.due[11] === 0);
  check(`...but under nothing in ${YEAR} by payment date`, ((await byDate())[late] ?? []).every((v) => v === 0));
  const nextYearByDate = await byDate(YEAR + 1);
  check(`...where it counts under JANUARY ${YEAR + 1} instead`, nextYearByDate[late]?.[0] === 400);
  const nextYearByBill = (await byBill(null, null, YEAR + 1))[late];
  check(`...and by billing month ${YEAR + 1} shows no bills for it at all`,
    nextYearByBill.paid.every((v) => v === null));

  /* ----------------------------------------------------------------- voids */
  console.log("\n== Voided payments ==");
  const voidMe = (await collect(nobody, [{ billing_month: m(8), amount: 300 }], onDay(8, 25)))[0];
  let nb = (await byBill())[nobody];
  check("before void: AUG 300 paid, 400 due", nb.paid[7] === 300 && nb.due[7] === 400);
  await db.query(`select public.void_payment('${voidMe.id}', 'test')`);
  nb = (await byBill())[nobody];
  check("after void: AUG 0 paid, 700 due again", nb.paid[7] === 0 && nb.due[7] === 700);

  /* --------------------------------------------------------------- filters */
  console.log("\n== Filters ==");
  // Two collectors on one bill: Jamal adds the last 100 to Molla's September.
  await as(jamal);
  await collect(molla, [{ billing_month: m(9), amount: 100 }], onDay(9, 25));
  await as(abbu);
  const mamaView = (await byBill(mama))[molla];
  const jamalView = (await byBill(jamal))[molla];
  check("collector filter: Mama's share of September is 400", mamaView.paid[8] === 400);
  check("collector filter: Jamal's share of September is 100", jamalView.paid[8] === 100);
  check("due ignores the collector filter - September is settled in both views",
    mamaView.due[8] === 0 && jamalView.due[8] === 0);
  check("so under Jamal's filter, August reads PAID though he collected 0 of it",
    jamalView.paid[7] === 0 && billCellState(jamalView.paid[7], jamalView.due[7]) === "paid");

  const allRows = await byBill();
  const dateRows = await byDate();
  check("lists exactly the same clients as the payment-date view",
    Object.keys(allRows).sort().join() === Object.keys(dateRows).sort().join(),
    `${Object.keys(allRows).length} vs ${Object.keys(dateRows).length}`);
  const areaRows = await byBill(null, area);
  check("area filter drops the client with no area", !(nobody in areaRows) && khan in areaRows);

  /* ----------------------------------------------- reconciles with summary */
  console.log("\n== Adds up to the report's own summary cards ==");
  const summary = (await one(`select public.collection_summary(${YEAR}) s`)).s;
  const sumTotal = Object.values(allRows).reduce((s, r) => s + r.total, 0);
  const sumDue = Object.values(allRows).reduce((s, r) => s + r.yearDue, 0);
  check("sum of year totals = billed_collected on the summary",
    sumTotal === Number(summary.billed_collected), `${sumTotal} vs ${summary.billed_collected}`);
  check("sum of year due = outstanding on the summary",
    sumDue === Number(summary.outstanding), `${sumDue} vs ${summary.outstanding}`);

  /* -------------------------------------------------------- adjustments */
  console.log("\n== Discounts ==");
  const octBill = (await one(`select id from public.monthly_bills where client_id='${khan}' and billing_month='${m(10)}'`)).id;
  await db.query(`select public.set_bill_adjustment('${octBill}', 200, 'discount', 'loyal')`);
  check("a discount reduces what is due, not what is shown as paid",
    (await byBill())[khan].due[9] === 300 && (await byBill())[khan].paid[9] === 0);

  /* --------------------------------------------------------------- years */
  console.log("\n== Report years ==");
  const futureBillYear = YEAR + 2;
  await db.exec(`insert into public.monthly_bills (client_id, billing_month, bill_amount)
    values ('${nobody}', '${futureBillYear}-01-01', 700)`);
  const years = (await rows(`select report_year from public.collection_report_years()`)).map((r) => r.report_year);
  check("a year with bills but no payments is offered", years.includes(futureBillYear), JSON.stringify(years));
  check("years with payments are offered", years.includes(YEAR) && years.includes(YEAR + 1));
  check("newest first", years[0] === futureBillYear);

  /* --------------------------------------------------------------- access */
  console.log("\n== Access ==");
  await as(mama);
  await expectError("collectors cannot run the by-bill matrix",
    () => db.query(`select * from public.collection_matrix_by_bill(${YEAR})`), "ADMIN_ONLY");
  check("collectors get no report years", (await rows(`select * from public.collection_report_years()`)).length === 0);

  /* ------------------------------------------------------ setup.sql re-run */
  console.log("\n== setup.sql is safe to apply a second time ==");
  await as(abbu);
  const before = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  try {
    await db.exec(readFileSync(SETUP, "utf8"));
    check("setup.sql re-applies on a migrated, populated database", true);
  } catch (e) {
    check("setup.sql re-applies on a migrated, populated database", false, e.message);
  }
  const after = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  check("...changing no payment", Number(after.c) === Number(before.c) && Number(after.s) === Number(before.s));
  check("...and the by-bill matrix still answers", (await byBill())[khan].paid[7] === 500);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
