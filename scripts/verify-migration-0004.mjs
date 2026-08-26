/**
 * Migration-path check for 0004_bill_adjustments.sql.
 *
 *   npm run verify:migration
 *
 * The production database already holds bills and payments, so this does not
 * test 0004 on an empty schema. It builds the OLD schema, fills it with data,
 * then applies 0004 on top and proves nothing was lost or miscalculated.
 *
 * Then it runs the adjustment scenarios from the addendum (tests 4 and 5).
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const db = new PGlite({ extensions: { pg_trgm } });

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
}

async function expectError(name, fn, token) {
  try {
    await fn();
    fail++; failures.push(name);
    console.log(`  FAIL  ${name} (expected rejection, got success)`);
  } catch (e) {
    const m = String(e.message ?? e);
    if (!token || m.includes(token)) { pass++; console.log(`  PASS  ${name} -> ${m.split("\n")[0].slice(0, 62)}`); }
    else { fail++; failures.push(name); console.log(`  FAIL  ${name} (wrong error: ${m.split("\n")[0]})`); }
  }
}

const as = (id) => db.exec(`select set_config('app.current_user_id', '${id ?? ""}', false);`);

/** PGlite hands back Date objects for `date` columns. */
const toDateStr = (v) =>
  v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);
const sql = (f) => readFileSync(join(MIGRATIONS, f), "utf8");

async function bill(clientId, month) {
  const r = await db.query(
    `select bill_amount::float8 orig, adjustment_amount::float8 adj, adjusted_amount::float8 adjusted,
            paid_amount::float8 paid, due_amount::float8 due, status,
            adjustment_type, adjustment_reason, adjusted_by
       from public.monthly_bills where client_id='${clientId}' and billing_month='${month}'`,
  );
  return r.rows[0];
}

async function main() {
  console.log("\n== Stubs + OLD schema (pre-0004) ==");
  await db.exec(`
    create role anon; create role authenticated;
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;
  `);
  for (const f of ["0001_init_schema.sql", "0002_functions.sql", "0003_rls_policies.sql"]) {
    await db.exec(sql(f));
    console.log(`  applied ${f}`);
  }
  await db.exec(`grant usage on schema public to authenticated, anon;
                 grant select, insert, update, delete on all tables in schema public to authenticated;`);

  console.log("\n== Populate with real data (as production already is) ==");
  const abbu = randomUUID(), mama = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','{"full_name":"Mama","role":"collector"}');`);

  await as(abbu);
  const month = toDateStr((await db.query(`select public.dhaka_current_month() m`)).rows[0].m);
  const mk = async (code, name, amt) =>
    (await db.query(`select (public.upsert_client(null,'${code}','${name}',null,null,${amt},current_date-60,'active',null)).id id`)).rows[0].id;

  const rahim = await mk("C-1", "Rahim", 1000);
  const karim = await mk("C-2", "Karim", 1000);
  const sabbir = await mk("C-3", "Sabbir", 1000);
  const nasrin = await mk("C-4", "Nasrin", 1000);
  await db.query(`select * from public.generate_monthly_bills('${month}')`);

  // Pre-existing payments, recorded on the OLD schema.
  await as(mama);
  await db.query(`select public.record_payment('${rahim}','${month}',1000,'cash',null,null)`); // full
  await db.query(`select public.record_payment('${karim}','${month}',800,'cash',null,null)`);  // partial

  const before = {
    bills: (await db.query(`select count(*)::int n from public.monthly_bills`)).rows[0].n,
    payments: (await db.query(`select count(*)::int n from public.payments`)).rows[0].n,
    paid: (await db.query(`select coalesce(sum(paid_amount),0)::float8 s from public.monthly_bills`)).rows[0].s,
  };
  console.log(`  seeded: ${before.bills} bills, ${before.payments} payments, ৳${before.paid} collected`);

  /* ------------------------------------------------------------------ */
  console.log("\n== Apply 0004 on the populated table ==");
  await db.exec(sql("0004_bill_adjustments.sql"));
  console.log("  applied 0004_bill_adjustments.sql");

  const after = {
    bills: (await db.query(`select count(*)::int n from public.monthly_bills`)).rows[0].n,
    payments: (await db.query(`select count(*)::int n from public.payments`)).rows[0].n,
    paid: (await db.query(`select coalesce(sum(paid_amount),0)::float8 s from public.monthly_bills`)).rows[0].s,
  };
  check("no bills lost", before.bills === after.bills, `${before.bills} -> ${after.bills}`);
  check("no payments lost", before.payments === after.payments, `${before.payments} -> ${after.payments}`);
  check("collected total unchanged", before.paid === after.paid, `${before.paid} -> ${after.paid}`);

  const r = await bill(rahim, month);
  check("existing PAID bill still paid, adjustment defaults to 0",
    r.orig === 1000 && r.adj === 0 && r.adjusted === 1000 && r.paid === 1000 && r.due === 0 && r.status === "paid",
    JSON.stringify(r));

  const k0 = await bill(karim, month);
  check("existing PARTIAL bill still partial",
    k0.orig === 1000 && k0.adj === 0 && k0.adjusted === 1000 && k0.paid === 800 && k0.due === 200 && k0.status === "partial",
    JSON.stringify(k0));

  console.log("\n== Re-running 0004 is safe ==");
  await db.exec(sql("0004_bill_adjustments.sql"));
  const k1 = await bill(karim, month);
  check("idempotent: figures unchanged after second run",
    k1.paid === 800 && k1.due === 200 && k1.status === "partial", JSON.stringify(k1));

  /* ------------------------------------------------------------------ */
  console.log("\n== Addendum Test 4: business discount ==");
  console.log("   Bill 1000, adjustment 200, payment 800 -> due 0, PAID");
  await as(abbu);
  const sabbirBillId = (await db.query(
    `select id from public.monthly_bills where client_id='${sabbir}' and billing_month='${month}'`)).rows[0].id;
  await db.query(`select public.set_bill_adjustment('${sabbirBillId}',200,'discount','Owner approved special discount')`);

  let s = await bill(sabbir, month);
  check("after adjustment: adjusted 800, due 800, still UNPAID",
    s.orig === 1000 && s.adj === 200 && s.adjusted === 800 && s.paid === 0 && s.due === 800 && s.status === "unpaid",
    JSON.stringify(s));

  await as(mama);
  await db.query(`select public.record_payment('${sabbir}','${month}',800,'cash',null,null)`);
  s = await bill(sabbir, month);
  check("Test 4 result: paid 800, DUE 0, status PAID (not partial)",
    s.adjusted === 800 && s.paid === 800 && s.due === 0 && s.status === "paid", JSON.stringify(s));
  check("Test 4: original 1000 still visible for the record", s.orig === 1000);
  check("Test 4: reason and approver retained",
    s.adjustment_reason === "Owner approved special discount" && s.adjusted_by === abbu);

  await expectError("cannot overpay a discounted bill",
    () => db.query(`select public.record_payment('${sabbir}','${month}',1,'cash',null,null)`), "BILL_ALREADY_PAID");

  /* ------------------------------------------------------------------ */
  console.log("\n== Addendum Test 5: discount + partial payment ==");
  console.log("   Bill 1000, adjustment 200, payment 600 -> due 200, PARTIAL");
  await as(abbu);
  const nasrinBillId = (await db.query(
    `select id from public.monthly_bills where client_id='${nasrin}' and billing_month='${month}'`)).rows[0].id;
  await db.query(`select public.set_bill_adjustment('${nasrinBillId}',200,'waiver','Service issue this month')`);
  await as(mama);
  await db.query(`select public.record_payment('${nasrin}','${month}',600,'cash',null,null)`);

  const n = await bill(nasrin, month);
  check("Test 5 result: adjusted 800, paid 600, due 200, PARTIAL",
    n.adjusted === 800 && n.paid === 600 && n.due === 200 && n.status === "partial", JSON.stringify(n));

  await expectError("payment cannot exceed the remaining adjusted due",
    () => db.query(`select public.record_payment('${nasrin}','${month}',201,'cash',null,null)`),
    "PAYMENT_EXCEEDS_DUE|200.00");

  /* ------------------------------------------------------------------ */
  console.log("\n== Section 9: partial payment is NOT a discount ==");
  const k = await bill(karim, month);
  check("Karim (no adjustment) still owes 200",
    k.adj === 0 && k.due === 200 && k.status === "partial", JSON.stringify(k));
  check("Sabbir (adjusted) owes nothing, though both paid 800",
    (await bill(sabbir, month)).due === 0);

  /* ------------------------------------------------------------------ */
  console.log("\n== Authorisation: only admins adjust (section 13) ==");
  await as(mama);
  await expectError("collector cannot create an adjustment",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',500,'discount','sneaky')`), "ADMIN_ONLY");
  await expectError("collector cannot remove an adjustment",
    () => db.query(`select public.remove_bill_adjustment('${nasrinBillId}')`), "ADMIN_ONLY");

  await db.exec(`set role authenticated;`);
  const rogue = await db.query(
    `update public.monthly_bills set adjustment_amount = 900 where id='${nasrinBillId}'`);
  check("collector's direct adjustment UPDATE affects 0 rows",
    (rogue.affectedRows ?? 0) === 0 && (await bill(nasrin, month)).adj === 200);
  await db.exec(`reset role;`);

  /* ------------------------------------------------------------------ */
  console.log("\n== Adjustment validation (section 25) ==");
  await as(abbu);
  await expectError("adjustment requires a reason",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',100,'discount','')`),
    "ADJUSTMENT_REASON_REQUIRED");
  await expectError("adjustment requires a type",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',100,null,'no type given')`),
    "ADJUSTMENT_TYPE_REQUIRED");
  await expectError("adjustment cannot exceed the bill",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',1500,'discount','too big')`),
    "ADJUSTMENT_EXCEEDS_BILL|1000.00");
  await expectError("adjustment cannot waive money already collected",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',500,'discount','below paid')`),
    "ADJUSTMENT_BELOW_PAID|400.00");
  await expectError("negative adjustment rejected",
    () => db.query(`select public.set_bill_adjustment('${nasrinBillId}',-50,'discount','negative')`),
    "INVALID_AMOUNT");

  console.log("\n== Removing an adjustment restores the due ==");
  await db.query(`select public.remove_bill_adjustment('${sabbirBillId}')`);
  const sr = await bill(sabbir, month);
  check("removed: adjusted back to 1000, due 200, PARTIAL again",
    sr.adj === 0 && sr.adjusted === 1000 && sr.paid === 800 && sr.due === 200 && sr.status === "partial",
    JSON.stringify(sr));
  check("metadata cleared on removal",
    sr.adjustment_type === null && sr.adjustment_reason === null && sr.adjusted_by === null);
  // put it back so the dashboard maths below stays meaningful
  await db.query(`select public.set_bill_adjustment('${sabbirBillId}',200,'discount','Owner approved special discount')`);

  console.log("\n== Adjustments are audited (section 26) ==");
  const auditRows = await db.query(
    `select action, new_data->>'adjustment_reason' reason from public.audit_logs
      where action like 'bill.adjustment%' order by created_at`);
  check("adjustment set/removed both audited with reason",
    auditRows.rows.length >= 3 && auditRows.rows.some(a => a.action === "bill.adjustment_set")
      && auditRows.rows.some(a => a.action === "bill.adjustment_removed"),
    JSON.stringify(auditRows.rows.map(a => a.action)));

  /* ------------------------------------------------------------------ */
  console.log("\n== Dashboard + reports reflect adjustments ==");
  const sum = (await db.query(`select public.dashboard_summary('${month}') s`)).rows[0].s;
  const N = (k) => Number(sum[k]);
  console.log(`   original ${N("original_amount")} | adjustment ${N("adjustment_amount")} | billed ${N("billed_amount")} | collected ${N("collected_amount")} | due ${N("due_amount")}`);
  check("dashboard: billed = original - adjustment",
    N("billed_amount") === N("original_amount") - N("adjustment_amount"));
  check("dashboard: collected + due = billed (invariant holds)",
    N("collected_amount") + N("due_amount") === N("billed_amount"));
  check("dashboard: adjusted_count = 2", N("adjusted_count") === 2);

  const series = await db.query(`select * from public.monthly_series(3)`);
  const cur = series.rows.find((row) => toDateStr(row.billing_month) === month);
  check("monthly_series: collected + due = billed",
    Number(cur.collected_amount) + Number(cur.due_amount) === Number(cur.billed_amount),
    JSON.stringify(cur));
  check("monthly_series exposes original and adjustment",
    Number(cur.original_amount) === 4000 && Number(cur.adjustment_amount) === 400, JSON.stringify(cur));

  const dueReport = await db.query(
    `select count(*)::int n, coalesce(sum(due_amount),0)::float8 s from public.monthly_bills where due_amount > 0`);
  check("due report excludes fully-waived-and-paid bills",
    dueReport.rows[0].n === 2 && dueReport.rows[0].s === 400, JSON.stringify(dueReport.rows[0]));

  console.log("\n" + "=".repeat(62));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(62));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
