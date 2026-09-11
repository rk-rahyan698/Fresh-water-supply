/**
 * Verifies 0012_client_overview_bill_filter.sql.
 *
 *   npm run verify:billfilter
 *
 * A collector opening Clients could not tell who had paid. This proves the
 * filter behind the new Payment dropdown:
 *
 *   1. 'paid', 'due' and 'unbilled' each return exactly the right clients, and
 *      together they are everyone - nobody falls between the options.
 *   2. The filter agrees with the status badge on every row, a partial bill
 *      counts as unpaid, and a bill waived to zero counts as paid.
 *   3. total_count and pagination follow the filtered set, and two clients
 *      with the same name never repeat or vanish across pages.
 *   4. It combines with month, area, client status and search; a void moves a
 *      client back to unpaid.
 *   5. With no bill filter it returns what client_month_overview() does, which
 *      stays in place for the build that is still deployed.
 *   6. Collectors may call it, and setup.sql still re-runs cleanly.
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
  "0012_client_overview_bill_filter",
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
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
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

  console.log("== Applying 0001-0012 ==");
  for (const f of ALL) {
    try { await db.exec(sql(f)); check(`${f} applied`, true); }
    catch (e) { check(`${f} applied`, false, e.message); }
  }
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  {
    const r = await one(`select count(*) c,
        bool_or(has_function_privilege('anon', p.oid, 'execute')) a,
        bool_or(has_function_privilege('authenticated', p.oid, 'execute')) au
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname='public' and p.proname='client_month_overview_filtered'`);
    check("client_month_overview_filtered(): exactly one overload", Number(r.c) === 1, `found ${r.c}`);
    check("client_month_overview_filtered(): anon denied, authenticated allowed", r.a === false && r.au === true);
  }

  /* ------------------------------------------------------------- fixtures */
  const abbu = randomUUID(), mama = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}');`);
  await as(abbu);

  // A past year, so no payment date is ever in the future.
  const today = String((await one(`select public.dhaka_today()::text d`)).d);
  const YEAR = Number(today.slice(0, 4)) - 1;
  const m = (month) => `${YEAR}-${String(month).padStart(2, "0")}-01`;
  const SEP = m(9), OCT = m(10);

  const areaA = (await one(`select (public.upsert_area(null,'Dhanmondi','s',true)).id id`)).id;
  const areaB = (await one(`select (public.upsert_area(null,'Mirpur','s',true)).id id`)).id;
  const mk = async (code, name, amt, start, areaId, status = "active", id = null) => (await one(
    `select (public.upsert_client(${lit(id)},'${code}','${name}',null,null,${amt},'${start}','${status}',null,${lit(areaId)})).id id`)).id;

  const pappu  = await mk("WS-0001", "Pappu Paid",     500, m(8), areaA);
  const parvin = await mk("WS-0002", "Parvin Partial", 500, m(8), areaA);
  const umar   = await mk("WS-0003", "Umar Unpaid",    500, m(8), areaB);
  const wahid  = await mk("WS-0004", "Wahid Waived",   500, m(8), areaB);
  const lutfa  = await mk("WS-0005", "Lutfa Late",     400, OCT,  areaA);
  const molla1 = await mk("WS-0050", "Abdul Molla",    900, m(8), areaA);
  const molla2 = await mk("WS-0071", "Abdul Molla",    300, m(8), areaB);
  const gani   = await mk("WS-0009", "Gani Gone",      500, m(8), null);
  for (const month of [m(8), SEP, OCT]) await db.query(`select * from public.generate_monthly_bills('${month}')`);
  // Deactivated AFTER billing, so an inactive client still owes September.
  await mk("WS-0009", "Gani Gone", 500, m(8), null, "inactive", gani);

  const billId = async (client, month) =>
    (await one(`select id from public.monthly_bills where client_id='${client}' and billing_month='${month}'`)).id;
  const collect = async (client, month, amount, day = 15) => (await rows(`select * from public.record_collection('${client}',
    '${JSON.stringify([{ billing_month: month, amount }])}'::jsonb, 'cash', null, '${month.slice(0, 8)}${day}')`))[0];

  await as(mama);
  const pappuPayment = await collect(pappu, SEP, 500);
  await collect(parvin, SEP, 200);
  await as(abbu);
  await db.query(`select public.set_bill_adjustment('${await billId(wahid, SEP)}', 500, 'waiver', 'hardship')`);

  const call = async ({ month = SEP, area = null, search = null, status = "active", state = null, limit = 50, offset = 0 } = {}) =>
    rows(`select * from public.client_month_overview_filtered(${lit(month)}, ${lit(area)}, ${lit(search)},
      ${status ? `'${status}'::public.client_status` : "null"}, ${lit(state)}, ${limit}, ${offset})`);
  const ids = (rs) => rs.map((r) => r.client_id).sort().join();
  const set = (...xs) => [...xs].sort().join();

  /* ------------------------------------------------------- each filter */
  console.log("\n== Each filter returns exactly the right clients (September, active) ==");
  const all = await call();
  const paid = await call({ state: "paid" });
  const due = await call({ state: "due" });
  const unbilled = await call({ state: "unbilled" });

  check("no filter: every active client", ids(all) === set(pappu, parvin, umar, wahid, lutfa, molla1, molla2),
    `${all.length} rows`);
  check("'paid': Pappu, and Wahid whose bill was waived to zero", ids(paid) === set(pappu, wahid),
    paid.map((r) => r.name).join());
  check("'due': Umar (unpaid), Parvin (partial) and both Abdul Mollas",
    ids(due) === set(parvin, umar, molla1, molla2), due.map((r) => r.name).join());
  check("'unbilled': Lutfa, who starts in October", ids(unbilled) === set(lutfa),
    unbilled.map((r) => r.name).join());
  check("the three options never overlap and leave nobody out",
    ids([...paid, ...due, ...unbilled]) === ids(all) && paid.length + due.length + unbilled.length === all.length);

  console.log("\n== The filter agrees with the badge on every row ==");
  check("every 'paid' row has status paid and nothing due",
    paid.every((r) => r.bill_status === "paid" && Number(r.due_amount) === 0));
  check("every 'due' row is unpaid or partial with money still owed",
    due.every((r) => ["unpaid", "partial"].includes(r.bill_status) && Number(r.due_amount) > 0));
  check("Parvin's row reads partial with 300 due",
    due.some((r) => r.client_id === parvin && r.bill_status === "partial" && Number(r.due_amount) === 300));
  check("every 'unbilled' row has no bill at all",
    unbilled.every((r) => r.bill_id === null && r.bill_status === null && r.due_amount === null));
  check("a client viewed before they start has no rate yet, as in client_month_overview()",
    unbilled[0]?.monthly_bill === null);

  /* --------------------------------------------------- counts and pages */
  console.log("\n== total_count and pagination follow the filter ==");
  check("total_count on the filtered set, not every client",
    due.every((r) => Number(r.total_count) === 4) && paid.every((r) => Number(r.total_count) === 2));
  const firstPage = await call({ state: "due", limit: 1 });
  check("...and stays the full filtered count on a one-row page",
    firstPage.length === 1 && Number(firstPage[0].total_count) === 4);

  const paged = [];
  for (let offset = 0; offset < 4; offset++) paged.push(...(await call({ state: "due", limit: 1, offset })));
  check("paging one row at a time visits every unpaid client exactly once, same-name clients included",
    paged.length === 4 && new Set(paged.map((r) => r.client_id)).size === 4 && ids(paged) === ids(due),
    paged.map((r) => r.client_code).join());
  check("past the end is empty", (await call({ state: "due", limit: 1, offset: 4 })).length === 0);

  /* ------------------------------------------------------- combinations */
  console.log("\n== Combines with the other filters ==");
  check("unpaid + Dhanmondi: Parvin and the Dhanmondi Abdul Molla",
    ids(await call({ state: "due", area: areaA })) === set(parvin, molla1));
  check("paid + Mirpur: Wahid", ids(await call({ state: "paid", area: areaB })) === set(wahid));
  check("unpaid + every client status: includes the deactivated Gani",
    ids(await call({ state: "due", status: null })) === set(parvin, umar, molla1, molla2, gani));
  check("unpaid + search 'molla': both Abdul Mollas",
    ids(await call({ state: "due", search: "molla" })) === set(molla1, molla2));
  check("paid + search 'molla': nobody", (await call({ state: "paid", search: "molla" })).length === 0);

  const octUnbilled = await call({ month: OCT, state: "unbilled" });
  const octDue = await call({ month: OCT, state: "due" });
  check("October: Lutfa is billed now, so nobody is unbilled", octUnbilled.length === 0);
  check("October: every active client owes, Wahid's September waiver does not carry over",
    ids(octDue) === set(pappu, parvin, umar, wahid, lutfa, molla1, molla2));
  const novUnbilled = await call({ month: m(11), state: "unbilled" });
  check("November, bills not generated yet: everyone is under 'unbilled', nobody under 'due'",
    novUnbilled.length === all.length && (await call({ month: m(11), state: "due" })).length === 0);
  check("...each still showing their monthly rate",
    Number(novUnbilled.find((r) => r.client_id === lutfa)?.monthly_bill) === 400
      && Number(novUnbilled.find((r) => r.client_id === molla1)?.monthly_bill) === 900);
  check("a month given mid-month is read as that month",
    ids(await call({ month: `${YEAR}-09-17`, state: "paid" })) === set(pappu, wahid));

  console.log("\n== A void moves a client back to unpaid ==");
  await db.query(`select public.void_payment('${pappuPayment.id}', 'wrong client')`);
  check("Pappu leaves 'paid'", ids(await call({ state: "paid" })) === set(wahid));
  check("...and appears under 'due' as unpaid",
    (await call({ state: "due" })).some((r) => r.client_id === pappu && r.bill_status === "unpaid"));
  await as(mama);
  await collect(pappu, SEP, 500, 20);
  await as(abbu);
  check("collected again: back under 'paid'", ids(await call({ state: "paid" })) === set(pappu, wahid));

  /* ------------------------------------------------------- input handling */
  console.log("\n== Input handling ==");
  check("an empty bill state means no filter", (await call({ state: "" })).length === all.length);
  check("a blank search means no filter", (await call({ search: "   " })).length === all.length);
  await expectError("an unknown bill state is refused, not silently ignored",
    () => call({ state: "partial" }), "INVALID_BILL_STATE");
  check("a search for '%' is literal: nobody's name contains it", (await call({ search: "%" })).length === 0);

  /* ------------------------------------------ same answer as the old one */
  console.log("\n== With no bill filter it matches client_month_overview() ==");
  const old = await rows(`select * from public.client_month_overview('${SEP}', null, null, 'active', 50, 0)`);
  const fresh = await call();
  const shape = (r) => [r.client_id, r.client_code, r.name, r.area_name, Number(r.monthly_bill), r.client_status,
    r.bill_id, r.bill_amount === null ? null : Number(r.bill_amount), r.paid_amount === null ? null : Number(r.paid_amount),
    r.due_amount === null ? null : Number(r.due_amount), r.bill_status, Number(r.total_count)].join("|");
  const byId = (rs) => rs.map(shape).sort().join("\n");
  check("same clients, bills, amounts, statuses and total", byId(old) === byId(fresh));
  check("same column names, in the same order",
    Object.keys(old[0] ?? {}).join() === Object.keys(fresh[0] ?? {}).join());

  /* --------------------------------------------------------------- access */
  console.log("\n== Access ==");
  await as(mama);
  check("a collector gets the unpaid list", ids(await call({ state: "due" })) === set(parvin, umar, molla1, molla2));
  await as(null);
  await expectError("signed out: refused", () => call(), "AUTH_REQUIRED");
  await as(abbu);

  /* ------------------------------------------------------ setup.sql re-run */
  console.log("\n== setup.sql is safe to apply a second time ==");
  const before = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  try {
    await db.exec(readFileSync(SETUP, "utf8"));
    check("setup.sql re-applies on a migrated, populated database", true);
  } catch (e) {
    check("setup.sql re-applies on a migrated, populated database", false, e.message);
  }
  const after = await one(`select count(*) c, coalesce(sum(amount),0) s from public.payments`);
  check("...changing no payment", Number(after.c) === Number(before.c) && Number(after.s) === Number(before.s));
  const overloads = await one(`select
      count(*) filter (where proname = 'client_month_overview') old,
      count(*) filter (where proname = 'client_month_overview_filtered') new
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace where nsp.nspname = 'public'`);
  check("...leaving one client_month_overview and one client_month_overview_filtered",
    Number(overloads.old) === 1 && Number(overloads.new) === 1, JSON.stringify(overloads));
  check("...and the filter still answers", ids(await call({ state: "unbilled" })) === set(lutfa));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
