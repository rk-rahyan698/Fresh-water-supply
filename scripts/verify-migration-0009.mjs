/**
 * Verifies 0009_server_side_totals.sql.
 *
 *   npm run verify:totals
 *
 * WHAT THIS IS ABOUT
 *
 * The collections and bills screens each show a total under the table. Those
 * totals used to be computed in JavaScript: select every matching row, add the
 * column up in a reduce(). Supabase caps a response at the project's "Max rows"
 * setting - 1000 by default - and applies it silently, so past a thousand rows
 * the figure was the sum of the first thousand while the count printed next to
 * it stayed correct.
 *
 * 0009 moves both sums into the database. This suite proves:
 *
 *   1. The aggregate is exact above the 1000-row cap, and that a capped
 *      row-fetch really would have understated it (the bug, reproduced).
 *   2. Every filter matches the list query it belongs to, so the total under
 *      the table describes the rows above it.
 *   3. A search term containing % or _ is matched literally, not as a wildcard.
 *   4. RLS still scopes a collector to their own payments - the functions are
 *      SECURITY INVOKER, and this is the assertion that fails loudly if anyone
 *      ever makes them SECURITY DEFINER.
 *   5. anon cannot execute them.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const ALL = [
  "0001_init_schema", "0002_functions", "0003_rls_policies", "0004_bill_adjustments",
  "0005_areas_and_rates", "0006_analytics", "0007_collection_report",
  "0008_normalize_3nf", "0009_server_side_totals",
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

/** Calls payment_totals with only the arguments a test cares about. */
const paymentTotals = async (args = {}) => {
  const a = {
    p_from: null, p_to: null, p_billing_month: null, p_collector_id: null,
    p_client_id: null, p_area_id: null, p_method: null, p_search: null,
    p_include_voided: false, ...args,
  };
  const lit = (v) => (v === null ? "null" : typeof v === "boolean" ? String(v) : `'${v}'`);
  const call = `public.payment_totals(${lit(a.p_from)},${lit(a.p_to)},${lit(a.p_billing_month)},`
    + `${lit(a.p_collector_id)},${lit(a.p_client_id)},${lit(a.p_area_id)},`
    + `${a.p_method === null ? "null" : `'${a.p_method}'::public.payment_method`},`
    + `${lit(a.p_search)},${a.p_include_voided})`;
  const r = await one(`select ${call} t`);
  return { amount: n(r.t.total_amount), count: n(r.t.payment_count) };
};

const billTotals = async (month, status = null, areaId = null, search = null) => {
  const r = await one(`select public.bill_totals('${month}',
    ${status === null ? "null" : `'${status}'::public.bill_status`},
    ${areaId === null ? "null" : `'${areaId}'`},
    ${search === null ? "null" : `'${search}'`}) t`);
  return {
    original: n(r.t.original_amount), adjustment: n(r.t.adjustment_amount),
    adjusted: n(r.t.adjusted_amount), paid: n(r.t.paid_amount),
    due: n(r.t.due_amount), count: n(r.t.bill_count),
  };
};

async function main() {
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);

  console.log("== Applying 0001-0009 ==");
  for (const f of ALL) {
    try { await db.exec(sql(f)); check(`${f} applied`, true); }
    catch (e) { check(`${f} applied`, false, e.message); }
  }
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  /* ------------------------------------------------------ the two functions */
  console.log("\n== The functions are SECURITY INVOKER, not DEFINER ==");
  // This is the assertion that protects the security model. SECURITY DEFINER
  // here would bypass RLS and hand every collector the whole business's total.
  for (const fn of ["payment_totals", "bill_totals"]) {
    const r = await one(`select p.prosecdef from pg_proc p
      join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='${fn}'`);
    check(`${fn}() is SECURITY INVOKER`, r?.prosecdef === false, `prosecdef=${r?.prosecdef}`);
  }

  console.log("\n== anon cannot execute them ==");
  for (const fn of ["payment_totals", "bill_totals", "like_escape"]) {
    const r = await one(`select bool_or(has_function_privilege('anon', p.oid, 'execute')) a,
                                bool_or(has_function_privilege('authenticated', p.oid, 'execute')) au
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='${fn}'`);
    check(`${fn}(): anon denied, authenticated allowed`, r.a === false && r.au === true,
      `anon=${r.a} authenticated=${r.au}`);
  }

  /* ---------------------------------------------------------------- seeding */
  const abbu = randomUUID(), mama = randomUUID(), jamal = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}'),
    ('${jamal}','jamal@t.test','{"full_name":"Jamal","role":"collector"}');`);
  await as(abbu);

  const thisMonth = ds((await one(`select public.dhaka_current_month() m`)).m);
  const prev1 = shift(thisMonth, -1);

  console.log("\n== Seeding ==");
  const mirpur = (await one(`select (public.upsert_area(null,'Mirpur','north',true)).id id`)).id;
  const dhanmondi = (await one(`select (public.upsert_area(null,'Dhanmondi','south',true)).id id`)).id;

  const mk = async (code, name, amt, area) => (await one(
    `select (public.upsert_client(null,'${code}','${name}',null,null,${amt},'${prev1}','active',null,'${area}')).id id`)).id;

  const rahim = await mk("C-1", "Rahim", 1000, mirpur);
  const karim = await mk("C-2", "Karim", 800, mirpur);
  const hasan = await mk("C-3", "Hasan", 1200, dhanmondi);
  // A client code that is all ILIKE metacharacters, for the escaping test.
  const wild = await mk("C-100%_x", "Wildcard Wahid", 500, dhanmondi);

  for (const m of [prev1, thisMonth]) await db.query(`select * from public.generate_monthly_bills('${m}')`);

  // Mama collects; Jamal collects less; one payment is voided; one is a bank
  // transfer so the method filter has something to separate.
  await as(mama);
  await db.query(`select public.record_payment('${rahim}','${prev1}',1000,'cash',null,'${prev1}')`);
  await db.query(`select public.record_payment('${karim}','${thisMonth}',300,'cash',null,null)`);
  const voidable = (await one(
    `select (public.record_payment('${hasan}','${thisMonth}',200,'cash',null,null)).id id`)).id;
  await as(jamal);
  await db.query(`select public.record_payment('${hasan}','${prev1}',400,'bank',null,'${prev1}')`);
  await db.query(`select public.record_payment('${wild}','${thisMonth}',150,'mobile_banking',null,null)`);
  await as(abbu);
  await db.query(`select public.void_payment('${voidable}','collected in error')`);

  // Ground truth, straight from the rows, with no function involved.
  const truth = async (where) => {
    const r = await one(`select coalesce(sum(p.amount),0) s, count(*) c
      from public.payments p
      join public.monthly_bills b on b.id = p.monthly_bill_id
      join public.clients c on c.id = b.client_id
      where ${where}`);
    return { amount: n(r.s), count: n(r.c) };
  };

  /* -------------------------------------------------------------- parity */
  console.log("\n== payment_totals matches the rows it is aggregating ==");
  const allValid = await truth("p.voided_at is null");
  const t1 = await paymentTotals();
  check("unfiltered: amount and count match a direct sum",
    t1.amount === allValid.amount && t1.count === allValid.count,
    `fn=${JSON.stringify(t1)} rows=${JSON.stringify(allValid)}`);
  check("the voided payment is excluded by default", t1.amount === 1850 && t1.count === 4,
    `got ${JSON.stringify(t1)}`);

  const withVoided = await paymentTotals({ p_include_voided: true });
  check("include_voided adds it back", withVoided.amount === 2050 && withVoided.count === 5,
    `got ${JSON.stringify(withVoided)}`);

  /* ------------------------------------------------------------- filters */
  console.log("\n== Every filter narrows the same way the list does ==");
  const byCollector = await paymentTotals({ p_collector_id: mama });
  check("collector filter", byCollector.amount === 1300 && byCollector.count === 2,
    `got ${JSON.stringify(byCollector)}`);

  const byMonth = await paymentTotals({ p_billing_month: prev1 });
  check("billing_month filter (on the bill, not the payment)",
    byMonth.amount === 1400 && byMonth.count === 2, `got ${JSON.stringify(byMonth)}`);

  const byClient = await paymentTotals({ p_client_id: hasan, p_include_voided: true });
  check("client filter reaches through the bill (payments has no client_id)",
    byClient.amount === 600 && byClient.count === 2, `got ${JSON.stringify(byClient)}`);

  const byArea = await paymentTotals({ p_area_id: mirpur });
  check("area filter", byArea.amount === 1300 && byArea.count === 2,
    `got ${JSON.stringify(byArea)}`);

  const byMethod = await paymentTotals({ p_method: "bank" });
  check("method filter", byMethod.amount === 400 && byMethod.count === 1,
    `got ${JSON.stringify(byMethod)}`);

  const byDate = await paymentTotals({ p_from: prev1, p_to: prev1 });
  check("from/to date range", byDate.amount === 1400 && byDate.count === 2,
    `got ${JSON.stringify(byDate)}`);

  const combined = await paymentTotals({ p_collector_id: mama, p_area_id: mirpur, p_billing_month: prev1 });
  check("filters combine (collector + area + month)",
    combined.amount === 1000 && combined.count === 1, `got ${JSON.stringify(combined)}`);

  const bySearch = await paymentTotals({ p_search: "Rahim" });
  check("search matches the client through the bill",
    bySearch.amount === 1000 && bySearch.count === 1, `got ${JSON.stringify(bySearch)}`);

  const blankSearch = await paymentTotals({ p_search: "   " });
  check("a whitespace-only search is not a filter",
    blankSearch.amount === allValid.amount, `got ${JSON.stringify(blankSearch)}`);

  /* -------------------------------------------------- ILIKE metacharacters */
  console.log("\n== A search term is matched literally, not as a wildcard ==");
  // Unescaped, "%" is ILIKE for "anything" and would match every payment in
  // the database. Escaped, it matches only the one client whose code really
  // does contain a percent sign.
  const pct = await paymentTotals({ p_search: "%" });
  check("'%' is literal: it matches only the code containing one, not everything",
    pct.count === 1 && pct.amount === 150 && pct.count < allValid.count,
    `got ${JSON.stringify(pct)} of ${allValid.count} payments`);

  const underscore = await paymentTotals({ p_search: "C-1_0" });
  check("'_' is literal, so 'C-1_0' does not match 'C-100%_x'",
    underscore.count === 0, `got ${JSON.stringify(underscore)}`);

  const literalCode = await paymentTotals({ p_search: "C-100%_x" });
  check("the real code containing % and _ still matches itself",
    literalCode.amount === 150 && literalCode.count === 1, `got ${JSON.stringify(literalCode)}`);

  /* -------------------------------------------------------------- the bug */
  console.log("\n== Above the 1000-row API cap ==");
  // 30 clients x 45 months, one payment each: 1350 payments of 100 = 135,000.
  // Inserted directly so the seeding stays quick; the aggregate does not care
  // how the rows arrived.
  await db.exec(`
    insert into public.clients (id, client_code, name, start_date, status, area_id)
    select gen_random_uuid(), 'BULK-' || g, 'Bulk Client ' || g, '2019-01-01', 'active', '${mirpur}'
      from generate_series(1,30) g;

    insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason)
    select c.id, 100, '2019-01-01', 'Opening rate'
      from public.clients c where c.client_code like 'BULK-%';

    insert into public.monthly_bills (client_id, billing_month, bill_amount)
    select c.id, (date '2019-01-01' + (m || ' months')::interval)::date, 100
      from public.clients c, generate_series(0,44) m
     where c.client_code like 'BULK-%';

    insert into public.payments (monthly_bill_id, amount, payment_date, payment_method, collected_by)
    select b.id, 100, b.billing_month, 'cash', '${mama}'
      from public.monthly_bills b
      join public.clients c on c.id = b.client_id
     where c.client_code like 'BULK-%';

    -- A further 22 months per client that were never collected: 660 unpaid
    -- bills, comfortably past the Due Report's 500-row list cap.
    insert into public.monthly_bills (client_id, billing_month, bill_amount)
    select c.id, (date '2019-01-01' + (m || ' months')::interval)::date, 100
      from public.clients c, generate_series(45,66) m
     where c.client_code like 'BULK-%';`);

  const bulk = await paymentTotals({ p_search: "Bulk Client" });
  check("1350 bulk payments aggregate to the exact total",
    bulk.count === 1350 && bulk.amount === 135000, `got ${JSON.stringify(bulk)}`);

  // Reproduce what the old application code did: fetch the rows the API would
  // have returned under a 1000-row cap, and add them up here.
  const capped = await rows(`select p.amount from public.payments p
      join public.monthly_bills b on b.id = p.monthly_bill_id
      join public.clients c on c.id = b.client_id
     where c.client_code like 'BULK-%' limit 1000`);
  const cappedSum = capped.reduce((s, r) => s + n(r.amount), 0);
  check("a capped row-fetch really does understate it (the bug)",
    cappedSum === 100000 && cappedSum < bulk.amount,
    `capped=${cappedSum} true=${bulk.amount}`);
  check("the aggregate returns one row regardless of how many it summed",
    (await rows(`select public.payment_totals(null,null,null,null,null,null,null,'Bulk Client',false)`)).length === 1);

  /* ------------------------------------------------------------------ RLS */
  console.log("\n== RLS still scopes a collector to their own payments ==");
  // payment_totals is SECURITY INVOKER, so the policy from 0003 applies:
  //   payments_select: is_admin() or collected_by = auth.uid()
  const adminTotal = await paymentTotals();

  await as(mama);
  await db.exec(`set role authenticated;`);
  const mamaSeesUnfiltered = await paymentTotals();
  await db.exec(`reset role;`);

  await as(jamal);
  await db.exec(`set role authenticated;`);
  const jamalSeesUnfiltered = await paymentTotals();
  await db.exec(`reset role;`);

  await as(abbu);
  const mamaOwn = await paymentTotals({ p_collector_id: mama });
  const jamalOwn = await paymentTotals({ p_collector_id: jamal });

  check("a collector asking for 'everything' gets only their own total",
    mamaSeesUnfiltered.amount === mamaOwn.amount && mamaSeesUnfiltered.count === mamaOwn.count,
    `collector=${JSON.stringify(mamaSeesUnfiltered)} own=${JSON.stringify(mamaOwn)}`);
  check("a second collector likewise sees only theirs",
    jamalSeesUnfiltered.amount === jamalOwn.amount && jamalSeesUnfiltered.count === jamalOwn.count,
    `collector=${JSON.stringify(jamalSeesUnfiltered)} own=${JSON.stringify(jamalOwn)}`);
  check("neither collector can see the business total",
    mamaSeesUnfiltered.amount < adminTotal.amount && jamalSeesUnfiltered.amount < adminTotal.amount,
    `mama=${mamaSeesUnfiltered.amount} jamal=${jamalSeesUnfiltered.amount} admin=${adminTotal.amount}`);
  check("the admin does see the business total",
    adminTotal.amount === mamaOwn.amount + jamalOwn.amount,
    `admin=${adminTotal.amount} mama=${mamaOwn.amount} jamal=${jamalOwn.amount}`);

  /* ----------------------------------------------------------- bill_totals */
  console.log("\n== bill_totals ==");
  const bt = await billTotals(thisMonth);
  const btTruth = await one(`select coalesce(sum(bill_amount),0) o, coalesce(sum(adjustment_amount),0) adj,
    coalesce(sum(adjusted_amount),0) a, coalesce(sum(paid_amount),0) p, coalesce(sum(due_amount),0) d, count(*) c
    from public.monthly_bills where billing_month='${thisMonth}'`);
  check("every column matches a direct sum",
    bt.original === n(btTruth.o) && bt.adjustment === n(btTruth.adj) && bt.adjusted === n(btTruth.a)
      && bt.paid === n(btTruth.p) && bt.due === n(btTruth.d) && bt.count === n(btTruth.c),
    `fn=${JSON.stringify(bt)} rows=${JSON.stringify(btTruth)}`);
  check("paid + due reconciles to the adjusted total",
    bt.paid + bt.due === bt.adjusted, `${bt.paid} + ${bt.due} != ${bt.adjusted}`);

  // An adjustment, so the original and the adjusted total are different numbers.
  const rahimThisMonth = (await one(
    `select id from public.monthly_bills where client_id='${rahim}' and billing_month='${thisMonth}'`)).id;
  await db.query(`select public.set_bill_adjustment('${rahimThisMonth}',200,'discount','goodwill')`);
  const btAdj = await billTotals(thisMonth);
  check("an adjustment moves adjusted but leaves the original alone",
    btAdj.original === bt.original && btAdj.adjustment === bt.adjustment + 200
      && btAdj.adjusted === bt.adjusted - 200,
    `before=${JSON.stringify(bt)} after=${JSON.stringify(btAdj)}`);
  check("paid + due still reconciles after the adjustment",
    btAdj.paid + btAdj.due === btAdj.adjusted);

  const btArea = await billTotals(thisMonth, null, dhanmondi);
  const btAreaTruth = await one(`select coalesce(sum(b.adjusted_amount),0) a, count(*) c
    from public.monthly_bills b join public.clients c on c.id=b.client_id
    where b.billing_month='${thisMonth}' and c.area_id='${dhanmondi}'`);
  check("area filter", btArea.adjusted === n(btAreaTruth.a) && btArea.count === n(btAreaTruth.c),
    `fn=${JSON.stringify(btArea)} rows=${JSON.stringify(btAreaTruth)}`);

  const btUnpaid = await billTotals(thisMonth, "unpaid");
  const btUnpaidTruth = await one(`select count(*) c from public.monthly_bills
    where billing_month='${thisMonth}' and status='unpaid'`);
  check("status filter", btUnpaid.count === n(btUnpaidTruth.c),
    `fn=${btUnpaid.count} rows=${btUnpaidTruth.c}`);

  const btSearch = await billTotals(thisMonth, null, null, "Rahim");
  check("search filter", btSearch.count === 1, `got ${JSON.stringify(btSearch)}`);

  const btEmpty = await billTotals(shift(thisMonth, 6));
  check("a month with no bills returns zeros, not null",
    btEmpty.original === 0 && btEmpty.adjusted === 0 && btEmpty.count === 0,
    `got ${JSON.stringify(btEmpty)}`);

  /* ------------------------------------------------------------ due_totals */
  console.log("\n== due_totals: the Due Report's headline figures ==");
  const dueTotals = async (month = null, areaId = null, minDue = null, search = null) => {
    const r = await one(`select public.due_totals(
      ${month === null ? "null" : `'${month}'`},
      ${areaId === null ? "null" : `'${areaId}'`},
      ${minDue === null ? "null" : minDue},
      ${search === null ? "null" : `'${search}'`}) t`);
    return { due: n(r.t.total_due), bills: n(r.t.bill_count), clients: n(r.t.client_count) };
  };

  const dt = await dueTotals();
  const dtTruth = await one(`select coalesce(sum(due_amount),0) d, count(*) c,
    count(distinct client_id) cc from public.monthly_bills where due_amount > 0`);
  check("total, bill count and client count match a direct query",
    dt.due === n(dtTruth.d) && dt.bills === n(dtTruth.c) && dt.clients === n(dtTruth.cc),
    `fn=${JSON.stringify(dt)} rows=${JSON.stringify(dtTruth)}`);

  check("clients are counted distinctly, not once per unpaid month",
    dt.clients < dt.bills, `clients=${dt.clients} bills=${dt.bills}`);

  // The bug, reproduced: the report used to sum only the rows it listed.
  const capped500 = await rows(`select due_amount from public.monthly_bills
    where due_amount > 0 order by due_amount desc limit 500`);
  const capped500Sum = capped500.reduce((s, r) => s + n(r.due_amount), 0);
  check("summing only the listed 500 rows understates the true total (the bug)",
    capped500Sum < dt.due && capped500.length === 500,
    `capped=${capped500Sum} true=${dt.due} rows=${capped500.length}`);

  const dtMin = await dueTotals(null, null, 100);
  const dtMinTruth = await one(`select coalesce(sum(due_amount),0) d, count(*) c
    from public.monthly_bills where due_amount >= 100`);
  check("min_due filter", dtMin.due === n(dtMinTruth.d) && dtMin.bills === n(dtMinTruth.c),
    `fn=${JSON.stringify(dtMin)} rows=${JSON.stringify(dtMinTruth)}`);

  const dtArea = await dueTotals(null, dhanmondi);
  const dtAreaTruth = await one(`select coalesce(sum(b.due_amount),0) d, count(*) c
    from public.monthly_bills b join public.clients c on c.id=b.client_id
    where b.due_amount > 0 and c.area_id='${dhanmondi}'`);
  check("area filter", dtArea.due === n(dtAreaTruth.d) && dtArea.bills === n(dtAreaTruth.c),
    `fn=${JSON.stringify(dtArea)} rows=${JSON.stringify(dtAreaTruth)}`);

  const dtMonth = await dueTotals(thisMonth);
  const dtMonthTruth = await one(`select coalesce(sum(due_amount),0) d
    from public.monthly_bills where due_amount > 0 and billing_month='${thisMonth}'`);
  check("billing_month filter", dtMonth.due === n(dtMonthTruth.d),
    `fn=${dtMonth.due} rows=${dtMonthTruth.d}`);

  const dtNone = await dueTotals(null, null, 99999999);
  check("nothing outstanding returns zeros, not null",
    dtNone.due === 0 && dtNone.bills === 0 && dtNone.clients === 0,
    `got ${JSON.stringify(dtNone)}`);

  console.log("\n== due_totals is RLS-safe too ==");
  const r = await one(`select p.prosecdef from pg_proc p
    join pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname='public' and p.proname='due_totals'`);
  check("due_totals() is SECURITY INVOKER", r?.prosecdef === false, `prosecdef=${r?.prosecdef}`);
  const dueGrants = await one(`select bool_or(has_function_privilege('anon', p.oid, 'execute')) a,
      bool_or(has_function_privilege('authenticated', p.oid, 'execute')) au
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname='public' and p.proname='due_totals'`);
  check("due_totals(): anon denied, authenticated allowed",
    dueGrants.a === false && dueGrants.au === true, `anon=${dueGrants.a} auth=${dueGrants.au}`);

  console.log("\n== Re-running 0009 is safe ==");
  try {
    await db.exec(sql("0009_server_side_totals"));
    const again = await paymentTotals();
    check("re-applying changes nothing", again.amount === adminTotal.amount);
  } catch (e) {
    check("re-applying changes nothing", false, e.message);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
