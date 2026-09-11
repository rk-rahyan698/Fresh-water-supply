/**
 * Verifies 0010_multi_month_collection.sql and src/lib/collection-math.ts.
 *
 *   npm run verify:collection
 *
 * What it proves:
 *
 *   1. The reported scenario works: a client owing three months pays the
 *      current month plus part of the previous one, in ONE collection.
 *   2. A collection is atomic. If any month would be overpaid, no month is
 *      written - and the error names the month.
 *   3. Every rule record_payment() enforces still holds for each month, and
 *      the rows of one collection share created_at, collector and client,
 *      which is what the receipt groups them by.
 *   4. The oldest-first split the dialog shows is exactly what the database
 *      accepts, to the paisa.
 *   5. collection_bill_months() reports what was actually billed each month,
 *      so a mid-year rate change is visible - and a one-off discount is not
 *      mistaken for one.
 *   6. change_client_rate() can re-bill the current month at a new rate, and
 *      rolls the rate change back if the bill cannot take it.
 *   7. setup.sql can be applied a second time on a migrated database.
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
  "0005_areas_and_rates", "0006_analytics", "0007_collection_report",
  "0008_normalize_3nf", "0009_server_side_totals", "0010_multi_month_collection",
];

const { allocateOldestFirst, sumAllocations, summariseBillMonths, formatRanges } = await import(
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
const n = (v) => Number(v ?? 0);
const ds = (v) => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v).slice(0, 10);
const shift = (m, k) => {
  const [y, mm] = m.split("-").map(Number);
  const t = y * 12 + (mm - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function expectError(name, fn, fragment) {
  try { await fn(); check(name, false, "no error raised"); }
  catch (e) { check(name, String(e.message).includes(fragment), `got: ${e.message}`); }
}

const collect = (clientId, allocations, method = "cash", date = null) =>
  rows(`select * from public.record_collection('${clientId}',
          '${JSON.stringify(allocations)}'::jsonb, '${method}', null,
          ${date === null ? "null" : `'${date}'`})`);

async function main() {
  /* ================================================================ TS */
  console.log("== Oldest-first split (src/lib/collection-math.ts) ==");
  {
    const owes = [
      { billing_month: "2026-09-01", due: 1000 },
      { billing_month: "2026-07-01", due: 1000 },   // deliberately out of order
      { billing_month: "2026-08-01", due: 1000 },
    ];
    const r = allocateOldestFirst(owes, 2500);
    check("owes Jul/Aug/Sep, pays 2500 -> Jul 1000, Aug 1000, Sep 500",
      JSON.stringify(r.allocations) === JSON.stringify([
        { billing_month: "2026-07-01", amount: 1000 },
        { billing_month: "2026-08-01", amount: 1000 },
        { billing_month: "2026-09-01", amount: 500 },
      ]) && r.unallocated === 0, JSON.stringify(r));

    const partial = allocateOldestFirst(owes, 400);
    check("less than the oldest month's due touches only the oldest month",
      partial.allocations.length === 1 && partial.allocations[0].billing_month === "2026-07-01"
        && partial.allocations[0].amount === 400, JSON.stringify(partial));

    const over = allocateOldestFirst(owes, 3200);
    check("more than everything owed reports the excess as unallocated",
      sumAllocations(over.allocations) === 3000 && over.unallocated === 200, JSON.stringify(over));

    const paisa = allocateOldestFirst(
      [{ billing_month: "2026-07-01", due: 0.1 }, { billing_month: "2026-08-01", due: 0.2 }], 0.3);
    check("paisa arithmetic is exact (0.1 + 0.2 settles 0.3, nothing left over)",
      paisa.allocations.length === 2 && paisa.unallocated === 0
        && sumAllocations(paisa.allocations) === 0.3, JSON.stringify(paisa));

    const skipPaid = allocateOldestFirst(
      [{ billing_month: "2026-07-01", due: 0 }, { billing_month: "2026-08-01", due: 500 }], 300);
    check("a month with nothing due is skipped, not given a zero allocation",
      skipPaid.allocations.length === 1 && skipPaid.allocations[0].billing_month === "2026-08-01");

    check("a zero or negative amount allocates nothing",
      allocateOldestFirst(owes, 0).allocations.length === 0
        && allocateOldestFirst(owes, -50).allocations.length === 0);
  }

  console.log("\n== Monthly bill segments ==");
  {
    const flat = summariseBillMonths(Array(12).fill(1000));
    check("one amount all year is one segment, not flagged as changed",
      flat.segments.length === 1 && !flat.changed && formatRanges(flat.segments[0].ranges, MONTHS) === "Jan–Dec");

    const midYear = summariseBillMonths([1000, 1000, 1000, 1000, 1000, 1000, 1200, 1200, 1200, 1200, 1200, 1200]);
    check("a rate raised in July is two segments: 1000 Jan–Jun, 1200 Jul–Dec",
      midYear.changed && midYear.segments.length === 2
        && midYear.segments[0].amount === 1000 && formatRanges(midYear.segments[0].ranges, MONTHS) === "Jan–Jun"
        && midYear.segments[1].amount === 1200 && formatRanges(midYear.segments[1].ranges, MONTHS) === "Jul–Dec",
      JSON.stringify(midYear));
    check("latest is the most recent month's amount", midYear.latest === 1200);

    const gap = summariseBillMonths([1000, 1000, null, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    check("a gap in billing splits the range instead of claiming the missing month",
      gap.segments.length === 1 && !gap.changed
        && formatRanges(gap.segments[0].ranges, MONTHS) === "Jan–Feb, Apr–Dec", JSON.stringify(gap));

    const back = summariseBillMonths([1000, 1000, 1000, 1200, 1200, 1200, 1000, 1000, 1000, 1000, 1000, 1000]);
    check("up and back down again stays three segments - that is the history",
      back.segments.length === 3 && back.changed, JSON.stringify(back));

    const oneOff = summariseBillMonths([1000, 1000, 1000, 1000, 1000, 1000, 600, 1000, 1000, 1000, 1000, 1000]);
    check("a single edited month shows as its own month",
      oneOff.segments.length === 3 && formatRanges(oneOff.segments[1].ranges, MONTHS) === "Jul"
        && oneOff.segments[1].amount === 600);

    const startedLate = summariseBillMonths([null, null, null, null, 800, 800, 800, 800, 800, 800, 800, 800]);
    check("a client who started in May is May–Dec",
      formatRanges(startedLate.segments[0].ranges, MONTHS) === "May–Dec");

    const none = summariseBillMonths(Array(12).fill(null));
    check("no bills at all: no segments, no latest", none.segments.length === 0 && none.latest === null);
  }

  console.log("\n== The report PDF still fits the page with the new column ==");
  {
    // Same options collection-report-table.tsx passes: landscape A4, 40pt
    // margins, Client 86 / Area 50 / Monthly bill 68, then 12 months + total at
    // 7pt. autoTable reports "N units width could not fit page" when content
    // overflows - through console.LOG, not console.warn, which is easy to get
    // wrong and leaves this check passing no matter what. All three are
    // intercepted, and the check below proves it can fail.
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const warnings = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args) => {
      const line = args.join(" ");
      if (/could not fit|overflow/i.test(line)) warnings.push(line);
      else original.log(...args);
    };

    // First, prove the detector detects: deliberately oversized columns.
    console.log = console.warn = console.error = capture;
    try {
      const probe = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      autoTable(probe, {
        startY: 120, margin: { left: 40, right: 40 },
        head: [["Client", "Area", "Monthly bill", ...MONTHS, "Total"]],
        body: [["x", "y", "z", ...MONTHS.map(() => "12,500"), "1"]],
        styles: { fontSize: 7, cellPadding: 3 },
        columnStyles: { 0: { cellWidth: 300 }, 1: { cellWidth: 200 }, 2: { cellWidth: 200 } },
      });
    } finally {
      Object.assign(console, original);
    }
    check("the overflow detector really does catch a table that is too wide", warnings.length > 0,
      "no warning captured - the check below would be meaningless");
    warnings.length = 0;

    console.log = console.warn = console.error = capture;
    let bytes = 0;
    try {
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
      const changed = summariseBillMonths([1000, 1000, 1000, 1000, 1000, 1000, 1200, 1200, 1200, 1200, 1200, 1200]);
      const detail = changed.segments
        .map((s) => `${s.amount.toLocaleString("en-US")} ${formatRanges(s.ranges, MONTHS, "-")}`)
        .join("\n");
      const bigMonth = "12,500";
      autoTable(doc, {
        startY: 120,
        margin: { left: 40, right: 40 },
        head: [["Client", "Area", "Monthly bill", ...MONTHS, "Total"]],
        body: [
          ["Mohammad Rahimuddin\nC-0001", "Mirpur Section 10", detail, ...MONTHS.map(() => bigMonth), "150,000"],
          ["Karim\nC-0002", "Unassigned", "1,000", ...MONTHS.map(() => "1,000"), "12,000"],
        ],
        foot: [["TOTAL", "", "", ...MONTHS.map(() => "13,500"), "162,000"]],
        styles: { font: "helvetica", fontSize: 7, cellPadding: 3 },
        headStyles: { fontSize: 7 },
        columnStyles: { 0: { cellWidth: 86 }, 1: { cellWidth: 50 }, 2: { cellWidth: 68 }, 15: { fontStyle: "bold" } },
      });
      bytes = doc.output("arraybuffer").byteLength;
    } finally {
      Object.assign(console, original);
    }
    check("a changed monthly bill prints as two lines: 1,000 Jan-Jun / 1,200 Jul-Dec",
      formatRanges(summariseBillMonths([1000, 1000, 1000, 1000, 1000, 1000, 1200, 1200, 1200, 1200, 1200, 1200]).segments[1].ranges, MONTHS, "-") === "Jul-Dec");
    check("the landscape table fits with no overflow warning", warnings.length === 0, warnings.join(" | "));
    check("and produces a real PDF", bytes > 1000, `${bytes} bytes`);
  }

  /* =============================================================== SQL */
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);

  console.log("\n== Applying 0001-0010 ==");
  for (const f of ALL) {
    try { await db.exec(sql(f)); check(`${f} applied`, true); }
    catch (e) { check(`${f} applied`, false, e.message); }
  }
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  console.log("\n== Privileges ==");
  for (const fn of ["record_collection", "collection_bill_months", "change_client_rate", "collection_receipt"]) {
    const r = await one(`select bool_or(has_function_privilege('anon', p.oid, 'execute')) a,
        bool_or(has_function_privilege('authenticated', p.oid, 'execute')) au
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='${fn}'`);
    check(`${fn}(): anon denied, authenticated allowed`, r.a === false && r.au === true,
      `anon=${r.a} authenticated=${r.au}`);
  }

  const abbu = randomUUID(), mama = randomUUID(), jamal = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}'),
    ('${jamal}','jamal@t.test','{"full_name":"Jamal","role":"collector"}');`);
  await as(abbu);

  const thisMonth = ds((await one(`select public.dhaka_current_month() m`)).m);
  const prev1 = shift(thisMonth, -1);
  const prev2 = shift(thisMonth, -2);

  const mk = async (code, name, amt, start = prev2) => (await one(
    `select (public.upsert_client(null,'${code}','${name}',null,null,${amt},'${start}','active',null,null)).id id`)).id;

  const karim = await mk("C-1", "Karim", 1000);
  const rahim = await mk("C-2", "Rahim", 1000);
  for (const m of [prev2, prev1, thisMonth]) await db.query(`select * from public.generate_monthly_bills('${m}')`);

  const bill = async (clientId, month) => {
    const r = await one(`select id, bill_amount, adjusted_amount, paid_amount, due_amount, status
      from public.monthly_bills where client_id='${clientId}' and billing_month='${month}'`);
    return r && { id: r.id, bill: n(r.bill_amount), adjusted: n(r.adjusted_amount),
                  paid: n(r.paid_amount), due: n(r.due_amount), status: r.status };
  };
  const paymentCount = async (clientId) => n((await one(`select count(*) c from public.payments p
    join public.monthly_bills b on b.id=p.monthly_bill_id where b.client_id='${clientId}'`)).c);

  /* ------------------------------------------------ the reported scenario */
  console.log("\n== The reported scenario: current month + part of the previous one ==");
  // Karim owes three months of 1000. He pays 1600: all of this month and 600
  // of last month, recorded as ONE collection by the collector on the doorstep.
  await as(mama);
  const scenario = await collect(karim, [
    { billing_month: thisMonth, amount: 1000 },
    { billing_month: prev1, amount: 600 },
  ]);
  check("one call records two payments", scenario.length === 2, `got ${scenario.length}`);

  const k0 = await bill(karim, thisMonth), k1 = await bill(karim, prev1), k2 = await bill(karim, prev2);
  check("this month: paid 1000, due 0, PAID", k0.paid === 1000 && k0.due === 0 && k0.status === "paid",
    JSON.stringify(k0));
  check("last month: paid 600, due 400, PARTIAL", k1.paid === 600 && k1.due === 400 && k1.status === "partial",
    JSON.stringify(k1));
  check("the month before is untouched: due 1000, UNPAID", k2.paid === 0 && k2.due === 1000 && k2.status === "unpaid",
    JSON.stringify(k2));

  check("rows come back oldest month first, whatever order they were sent in",
    scenario[0].monthly_bill_id === k1.id && scenario[1].monthly_bill_id === k0.id);

  check("collected_by is stamped from the session on every row, not from the request",
    scenario.every((p) => p.collected_by === mama));
  check("every row of the collection shares created_at (what the receipt groups by)",
    new Set(scenario.map((p) => String(p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at))).size === 1);

  const audits = n((await one(`select count(*) c from public.audit_logs
    where action='payment.created' and entity_id in ('${scenario[0].id}','${scenario[1].id}')`)).c);
  check("each payment in the collection has its own audit entry", audits === 2, `got ${audits}`);

  /* ----------------------------------------------------------- atomicity */
  console.log("\n== A collection is all or nothing ==");
  const beforeCount = await paymentCount(karim);
  const beforeOld = await bill(karim, prev2);
  // prev2 still owes 1000 and prev1 owes 400. Asking for 500 against prev1
  // must fail - and must not leave prev2's 1000 recorded.
  await expectError("overpaying one month rejects the whole collection, naming the month",
    () => collect(karim, [{ billing_month: prev2, amount: 1000 }, { billing_month: prev1, amount: 500 }]),
    `COLLECTION_EXCEEDS_DUE|${prev1}|400.00`);
  check("nothing was written for the month that was valid",
    (await paymentCount(karim)) === beforeCount && (await bill(karim, prev2)).paid === beforeOld.paid,
    `count ${beforeCount} -> ${await paymentCount(karim)}`);

  await expectError("a month with no bill is named",
    () => collect(karim, [{ billing_month: prev2, amount: 100 }, { billing_month: shift(prev2, -1), amount: 100 }]),
    `COLLECTION_BILL_NOT_FOUND|${shift(prev2, -1)}`);
  check("...and the valid month beside it was not written either", (await paymentCount(karim)) === beforeCount);

  await expectError("a month already fully paid is named",
    () => collect(karim, [{ billing_month: thisMonth, amount: 50 }]), `COLLECTION_BILL_PAID|${thisMonth}`);

  await expectError("the same month twice is refused",
    () => collect(karim, [{ billing_month: prev2, amount: 100 }, { billing_month: prev2, amount: 100 }]),
    "COLLECTION_DUPLICATE_MONTH");

  await expectError("an empty collection is refused", () => collect(karim, []), "COLLECTION_EMPTY");

  await expectError("a zero amount is refused",
    () => collect(karim, [{ billing_month: prev2, amount: 0 }]), "INVALID_AMOUNT");

  await expectError("a future payment date is refused",
    () => collect(karim, [{ billing_month: prev2, amount: 100 }], "cash", shift(thisMonth, 2)),
    "FUTURE_PAYMENT_DATE");

  check("after all those refusals, still exactly the two original payments",
    (await paymentCount(karim)) === beforeCount);

  /* ------------------------------------------- TS split -> SQL, end to end */
  console.log("\n== The split the dialog shows is what the database accepts ==");
  // Rahim owes three months of 1000. He hands over 2500. The dialog's
  // oldest-first split goes straight into record_collection.
  const rahimBills = [];
  for (const m of [thisMonth, prev1, prev2]) {
    const b = await bill(rahim, m);
    rahimBills.push({ billing_month: m, due: b.due });
  }
  const split = allocateOldestFirst(rahimBills, 2500);
  const recorded = await collect(rahim, split.allocations);
  check("accepted as-is", recorded.length === 3);
  const r2 = await bill(rahim, prev2), r1 = await bill(rahim, prev1), r0 = await bill(rahim, thisMonth);
  check("oldest two cleared, current month left with 500",
    r2.due === 0 && r1.due === 0 && r0.paid === 500 && r0.due === 500,
    `prev2=${JSON.stringify(r2)} prev1=${JSON.stringify(r1)} now=${JSON.stringify(r0)}`);
  check("total recorded equals the amount handed over",
    recorded.reduce((s, p) => s + n(p.amount), 0) === 2500);

  /* -------------------------------------------------- receipt grouping */
  console.log("\n== Receipt grouping ==");
  // A separate, later collection for the same client by the same collector
  // must NOT appear on the first collection's receipt.
  await collect(rahim, [{ billing_month: thisMonth, amount: 100 }]);
  const anchor = recorded[0];
  const siblings = await rows(`
    select p.id from public.payments p
      join public.monthly_bills b on b.id = p.monthly_bill_id
     where p.created_at   = (select created_at   from public.payments where id='${anchor.id}')
       and p.collected_by = (select collected_by from public.payments where id='${anchor.id}')
       and b.client_id    = '${rahim}'`);
  check("grouping by created_at + collector + client finds exactly that collection's 3 rows",
    siblings.length === 3 && recorded.every((p) => siblings.some((s) => s.id === p.id)),
    `found ${siblings.length}`);

  // Another collector collecting at the "same" moment for a different client
  // is out by construction (different client), and so is Karim's collection.
  const karimSiblings = await rows(`
    select p.id from public.payments p join public.monthly_bills b on b.id = p.monthly_bill_id
     where p.created_at = (select created_at from public.payments where id='${scenario[0].id}')
       and p.collected_by = '${mama}' and b.client_id = '${karim}'`);
  check("Karim's receipt shows Karim's two rows only", karimSiblings.length === 2);

  /* ----------------------------------------------------- adjusted bills */
  console.log("\n== Discounts cap the split, not the original bill ==");
  await as(abbu);
  const hasan = await mk("C-3", "Hasan", 1000, thisMonth);
  await db.query(`select * from public.generate_monthly_bills('${thisMonth}')`);
  const hasanBill = await bill(hasan, thisMonth);
  await db.query(`select public.set_bill_adjustment('${hasanBill.id}', 300, 'discount', 'loyal client')`);
  await as(jamal);
  await expectError("cannot collect the discounted-away part of a bill",
    () => collect(hasan, [{ billing_month: thisMonth, amount: 1000 }]), `COLLECTION_EXCEEDS_DUE|${thisMonth}|700.00`);
  const hasanPayment = (await collect(hasan, [{ billing_month: thisMonth, amount: 700 }]))[0];
  const hb = await bill(hasan, thisMonth);
  check("paying the adjusted 700 marks it PAID with nothing due",
    hb.paid === 700 && hb.due === 0 && hb.status === "paid", JSON.stringify(hb));

  /* --------------------------------------------------- who may collect */
  console.log("\n== Who may collect ==");
  await as(jamal);
  await db.exec(`set role authenticated;`);
  let collectorViaApi = null;
  try {
    collectorViaApi = await collect(rahim, [{ billing_month: thisMonth, amount: 50 }]);
  } catch (e) {
    collectorViaApi = e;
  }
  await db.exec(`reset role;`);
  check("a collector can record a collection through the authenticated role",
    Array.isArray(collectorViaApi) && collectorViaApi.length === 1 && collectorViaApi[0].collected_by === jamal,
    collectorViaApi instanceof Error ? collectorViaApi.message : JSON.stringify(collectorViaApi));

  await as(abbu);
  await db.query(`update public.profiles set is_active=false where id='${jamal}'`);
  await as(jamal);
  await expectError("a deactivated collector cannot", () =>
    collect(rahim, [{ billing_month: thisMonth, amount: 10 }]), "USER_INACTIVE");
  await as(abbu);
  await db.query(`update public.profiles set is_active=true where id='${jamal}'`);

  /* ======================================== collection_bill_months() */
  console.log("\n== collection_bill_months(): what was actually billed ==");
  await as(abbu);
  const lastYear = Number(thisMonth.slice(0, 4)) - 1;
  const ly = (m) => `${lastYear}-${String(m).padStart(2, "0")}-01`;

  // Nasrin: 1000 from January, raised to 1200 in July, with a discount in
  // October. set_client_rate() refuses past months by design, so the history
  // is written directly - the function under test only reads bills.
  const nasrin = (await one(`insert into public.clients (client_code, name, start_date, status)
    values ('C-9','Nasrin','${ly(1)}','active') returning id`)).id;
  await db.exec(`insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason) values
    ('${nasrin}', 1000, '${ly(1)}', 'Opening rate'),
    ('${nasrin}', 1200, '${ly(7)}', 'Rate increase');`);
  for (let m = 1; m <= 12; m++) await db.query(`select * from public.generate_monthly_bills('${ly(m)}')`);
  const octBill = (await one(`select id from public.monthly_bills where client_id='${nasrin}' and billing_month='${ly(10)}'`)).id;
  await db.query(`select public.set_bill_adjustment('${octBill}', 200, 'discount', 'festival')`);

  // Selim: started in April last year, no bill in June (removed), 800 otherwise.
  const selim = (await one(`insert into public.clients (client_code, name, start_date, status)
    values ('C-10','Selim','${ly(4)}','active') returning id`)).id;
  await db.exec(`insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason)
    values ('${selim}', 800, '${ly(4)}', 'Opening rate');`);
  for (let m = 4; m <= 12; m++) await db.query(`select * from public.generate_monthly_bills('${ly(m)}')`);
  await db.exec(`delete from public.monthly_bills where client_id='${selim}' and billing_month='${ly(6)}'`);

  const bm = await rows(`select client_id, bill_amounts from public.collection_bill_months(${lastYear})`);
  const byClient = Object.fromEntries(bm.map((r) => [r.client_id, r.bill_amounts.map((v) => (v === null ? null : n(v)))]));

  const nasrinMonths = byClient[nasrin];
  check("twelve entries per client", nasrinMonths?.length === 12, JSON.stringify(nasrinMonths));
  check("the July rate increase reaches the bills: 1000 Jan–Jun, 1200 Jul–Dec",
    nasrinMonths?.slice(0, 6).every((v) => v === 1000) && nasrinMonths?.slice(6).every((v) => v === 1200),
    JSON.stringify(nasrinMonths));
  check("October's discount is NOT shown as a change to the monthly bill",
    nasrinMonths?.[9] === 1200, `oct=${nasrinMonths?.[9]}`);

  const nasrinSummary = summariseBillMonths(nasrinMonths);
  check("which the column summarises as exactly two segments",
    nasrinSummary.changed && nasrinSummary.segments.length === 2
      && formatRanges(nasrinSummary.segments[1].ranges, MONTHS) === "Jul–Dec",
    JSON.stringify(nasrinSummary));

  const selimMonths = byClient[selim];
  check("months before a client started are NULL, not 0",
    selimMonths?.slice(0, 3).every((v) => v === null), JSON.stringify(selimMonths));
  check("a month with no bill is NULL", selimMonths?.[5] === null);
  check("...so the column reads Apr–May, Jul–Dec",
    formatRanges(summariseBillMonths(selimMonths).segments[0].ranges, MONTHS) === "Apr–May, Jul–Dec");

  check("clients with no bills in that year are left out", !(karim in byClient) && !(rahim in byClient));

  const withArea = (await one(`select (public.upsert_area(null,'Mirpur','n',true)).id id`)).id;
  await db.query(`update public.clients set area_id='${withArea}' where id='${nasrin}'`);
  const filtered = await rows(`select client_id from public.collection_bill_months(${lastYear}, '${withArea}')`);
  check("area filter", filtered.length === 1 && filtered[0].client_id === nasrin);

  await as(mama);
  await expectError("collectors cannot run it (same access as the collection report)",
    () => db.query(`select * from public.collection_bill_months(${lastYear})`), "ADMIN_ONLY");

  /* ========================================== change_client_rate() */
  console.log("\n== change_client_rate(): a mid-month increase ==");
  await as(abbu);
  const tariq = await mk("C-11", "Tariq", 1000, thisMonth);
  await db.query(`select * from public.generate_monthly_bills('${thisMonth}')`);
  await as(mama);
  await collect(tariq, [{ billing_month: thisMonth, amount: 400 }]);
  await as(abbu);

  const rateRows = async () => n((await one(`select count(*) c from public.client_rate_history where client_id='${tariq}'`)).c);
  const currentRate = async () => n((await one(`select public.client_current_rate('${tariq}') r`)).r);

  // Without the flag: the long-standing behaviour. The rate moves, this
  // month's already-generated bill does not.
  await db.query(`select public.change_client_rate('${tariq}', 1100, '${thisMonth}', 'test', false)`);
  let tb = await bill(tariq, thisMonth);
  check("without re-billing: the rate becomes 1100 but this month's bill stays 1000",
    (await currentRate()) === 1100 && tb.bill === 1000, `rate=${await currentRate()} bill=${tb.bill}`);

  // With the flag: both, together.
  const res = await one(`select public.change_client_rate('${tariq}', 1200, '${thisMonth}', 'mid-month increase', true) r`);
  tb = await bill(tariq, thisMonth);
  check("with re-billing: rate 1200 AND this month's bill 1200",
    (await currentRate()) === 1200 && tb.bill === 1200, `rate=${await currentRate()} bill=${tb.bill}`);
  check("the 400 already collected is kept, so due is 800 and status PARTIAL",
    tb.paid === 400 && tb.due === 800 && tb.status === "partial", JSON.stringify(tb));
  check("the result reports the bill it changed", res.r.bill && n(res.r.bill.bill_amount) === 1200);

  const audit = await one(`select count(*) c from public.audit_logs where action='bill.updated' and entity_id='${tb.id}'`);
  check("the bill change is audited with before and after", n(audit.c) === 1);

  const unchanged = await one(`select public.change_client_rate('${tariq}', 1200, '${thisMonth}', 'same again', true) r`);
  check("re-billing at the amount the bill already has changes nothing and reports no bill",
    unchanged.r.bill === null && (await bill(tariq, thisMonth)).bill === 1200);

  // Lowering below what is already collected must fail - and take the rate
  // row down with it.
  const ratesBefore = await rateRows();
  const rateBefore = await currentRate();
  await expectError("re-billing below what was already collected is refused",
    () => db.query(`select public.change_client_rate('${tariq}', 300, '${thisMonth}', 'too low', true)`),
    "BILL_BELOW_PAID|400.00");
  check("...and the rate change is rolled back with it",
    (await currentRate()) === rateBefore && (await rateRows()) === ratesBefore,
    `rate ${rateBefore} -> ${await currentRate()}`);

  await expectError("asking to re-bill for a future month is refused, not ignored",
    () => db.query(`select public.change_client_rate('${tariq}', 1500, '${shift(thisMonth, 1)}', 'x', true)`),
    "REBILL_ONLY_CURRENT_MONTH");
  check("...and no rate row was written for it", (await rateRows()) === ratesBefore);

  await db.query(`select public.change_client_rate('${tariq}', 1500, '${shift(thisMonth, 1)}', 'next month', false)`);
  await db.query(`select * from public.generate_monthly_bills('${shift(thisMonth, 1)}')`).catch(() => {});
  check("scheduling for next month without re-billing still works",
    (await rateRows()) === ratesBefore + 1 && (await bill(tariq, thisMonth)).bill === 1200);

  await as(mama);
  await expectError("collectors cannot change rates",
    () => db.query(`select public.change_client_rate('${tariq}', 5, '${thisMonth}', 'x', true)`), "ADMIN_ONLY");

  /* =========================================== collection_receipt() */
  console.log("\n== collection_receipt(): one receipt, right figures ==");
  await as(abbu);
  const receipt = async (paymentId) =>
    (await rows(`select * from public.collection_receipt('${paymentId}')`)).map((r) => ({
      month: ds(r.billing_month), bill: n(r.bill_amount), adjusted: n(r.adjusted_amount),
      prev: n(r.previously_paid), amount: n(r.amount), remaining: n(r.remaining_due), voided: r.voided,
    }));

  const karimReceipt = await receipt(scenario[1].id);   // opened from EITHER row of the collection
  check("Karim's collection prints as one receipt with both months, oldest first",
    karimReceipt.length === 2 && karimReceipt[0].month === prev1 && karimReceipt[1].month === thisMonth,
    JSON.stringify(karimReceipt));
  check("last month's line: 600 paid, 400 remaining",
    karimReceipt[0].amount === 600 && karimReceipt[0].prev === 0 && karimReceipt[0].remaining === 400);
  check("this month's line: 1000 paid, 0 remaining",
    karimReceipt[1].amount === 1000 && karimReceipt[1].remaining === 0);

  // BUG 1, reproduced: a discount applied before the payment.
  const hasanReceipt = await receipt(hasanPayment.id);
  const oldFormula = hasanReceipt[0].bill - hasanReceipt[0].prev - hasanReceipt[0].amount;
  check("the old receipt arithmetic printed a false 300 due on a discounted, fully paid bill (bug 1)",
    oldFormula === 300, `old formula gave ${oldFormula}`);
  check("collection_receipt prints 0 remaining - it uses the adjusted bill",
    hasanReceipt[0].remaining === 0 && hasanReceipt[0].adjusted === 700, JSON.stringify(hasanReceipt));

  // BUG 2, reproduced: two collectors on one bill.
  const babul = await mk("C-12", "Babul", 1500, thisMonth);
  await db.query(`select * from public.generate_monthly_bills('${thisMonth}')`);
  await as(mama);
  await collect(babul, [{ billing_month: thisMonth, amount: 1000 }]);
  await as(jamal);
  const jamalPay = (await collect(babul, [{ billing_month: thisMonth, amount: 500 }]))[0];
  const babulBillId = (await bill(babul, thisMonth)).id;

  await db.exec(`set role authenticated;`);
  const visibleToJamal = n((await one(`select coalesce(sum(amount),0) s from public.payments
    where monthly_bill_id='${babulBillId}' and voided_at is null
      and created_at < (select created_at from public.payments where id='${jamalPay.id}')`)).s);
  const jamalReceipt = await receipt(jamalPay.id);
  await db.exec(`reset role;`);

  check("through RLS, Jamal cannot see Mama's 1000 - so the old receipt said previously paid 0 (bug 2)",
    visibleToJamal === 0, `visible=${visibleToJamal}`);
  check("collection_receipt, called as Jamal, counts Mama's 1000 and prints 0 remaining",
    jamalReceipt.length === 1 && jamalReceipt[0].prev === 1000 && jamalReceipt[0].remaining === 0,
    JSON.stringify(jamalReceipt));

  console.log("\n== collection_receipt(): who may open it ==");
  await as(mama);
  await db.exec(`set role authenticated;`);
  let mamaOpensJamals;
  try { mamaOpensJamals = await receipt(jamalPay.id); } catch (e) { mamaOpensJamals = e; }
  await db.exec(`reset role;`);
  check("another collector cannot open it",
    mamaOpensJamals instanceof Error && mamaOpensJamals.message.includes("PAYMENT_NOT_FOUND"),
    mamaOpensJamals instanceof Error ? mamaOpensJamals.message : "returned rows");

  await as(abbu);
  check("an admin can", (await receipt(jamalPay.id)).length === 1);
  await expectError("an unknown id reads exactly like someone else's",
    () => receipt(randomUUID()), "PAYMENT_NOT_FOUND");

  const voidedOne = (await collect(rahim, [{ billing_month: thisMonth, amount: 25 }]))[0];
  await db.query(`select public.void_payment('${voidedOne.id}', 'test void')`);
  const voidedReceipt = await receipt(voidedOne.id);
  check("a voided payment still opens, flagged as voided",
    voidedReceipt.length === 1 && voidedReceipt[0].voided === true);

  /* ================================================ setup.sql re-run */
  console.log("\n== setup.sql is safe to apply a second time ==");
  await as(abbu);
  const totalsBefore = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  try {
    await db.exec(readFileSync(SETUP, "utf8"));
    check("the whole of setup.sql re-applies on a migrated, populated database", true);
  } catch (e) {
    check("the whole of setup.sql re-applies on a migrated, populated database", false, e.message);
  }
  const totalsAfter = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  check("...and no payment was added, lost or changed",
    n(totalsAfter.c) === n(totalsBefore.c) && n(totalsAfter.s) === n(totalsBefore.s));
  const stillWorks = await collect(karim, [{ billing_month: prev2, amount: 1 }]).catch((e) => e);
  check("record_collection still works after the re-run", Array.isArray(stillWorks) && stillWorks.length === 1,
    stillWorks instanceof Error ? stillWorks.message : "");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
