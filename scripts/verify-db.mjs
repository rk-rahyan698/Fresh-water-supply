/**
 * Database verification suite.
 *
 *   npm run verify:db
 *
 * Runs supabase/migrations/*.sql against PGlite (Postgres compiled to WASM) and
 * exercises the acceptance scenarios from the spec plus the RLS and data
 * integrity rules. No Docker and no Supabase account required, so it is safe to
 * run in CI or before a deploy.
 *
 * Supabase's own pieces are stubbed here: the `auth` schema, `auth.uid()`, and
 * the `anon` / `authenticated` roles that Supabase provisions for you. Every
 * other line of SQL is the real migration, unmodified.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const db = new PGlite({ extensions: { pg_trgm } });

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function expectError(name, fn, expectedToken) {
  try {
    await fn();
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name} (expected rejection, but it succeeded)`);
  } catch (error) {
    const message = String(error.message ?? error);
    if (!expectedToken || message.includes(expectedToken)) {
      pass++;
      console.log(`  PASS  ${name} -> ${message.split("\n")[0].slice(0, 70)}`);
    } else {
      fail++;
      failures.push(name);
      console.log(`  FAIL  ${name} (wrong error: ${message.split("\n")[0]})`);
    }
  }
}

/** Impersonate a user for auth.uid(). */
async function as(userId) {
  await db.exec(`select set_config('app.current_user_id', '${userId ?? ""}', false);`);
}

async function main() {
  /* ---------------- Supabase stubs ---------------- */
  console.log("\n== Setting up Supabase stubs ==");
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      phone text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );
    create or replace function auth.uid() returns uuid
      language sql stable as $$
        select nullif(current_setting('app.current_user_id', true), '')::uuid
      $$;
  `);
  console.log("  auth schema + auth.uid() ready");

  /* ---------------- Migrations ---------------- */
  console.log("\n== Running migrations ==");
  for (const file of [
    "0001_init_schema.sql",
    "0002_functions.sql",
    "0003_rls_policies.sql",
    "0004_bill_adjustments.sql",
  ]) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    try {
      await db.exec(sql);
      console.log(`  OK    ${file}`);
      pass++;
    } catch (error) {
      console.log(`  ERROR ${file}: ${error.message}`);
      fail++;
      failures.push(file);
      throw error;
    }
  }

  // Supabase grants these to authenticated by default.
  await db.exec(`
    grant usage on schema public to authenticated, anon;
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `);

  /* ---------------- Users ---------------- */
  console.log("\n== Users (auth trigger -> profiles) ==");
  const abbu = randomUUID();
  const mama = randomUUID();
  const jamal = randomUUID();

  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${abbu}', 'abbu@demo.test', '{"full_name":"Abbu","role":"admin"}'),
      ('${mama}', 'mama@demo.test', '{"full_name":"Mama","role":"collector"}'),
      ('${jamal}','jamal@demo.test','{"full_name":"Jamal","role":"collector"}');
  `);

  const profiles = await db.query(`select id, full_name, role from public.profiles order by full_name`);
  check("auth trigger created 3 profiles", profiles.rows.length === 3, JSON.stringify(profiles.rows));
  check(
    "role read from user metadata",
    profiles.rows.find((r) => r.full_name === "Abbu")?.role === "admin" &&
      profiles.rows.find((r) => r.full_name === "Mama")?.role === "collector",
  );

  /* ---------------- Clients ---------------- */
  console.log("\n== Clients ==");
  await as(abbu);
  const rahim = (
    await db.query(
      `select (public.upsert_client(null,'C-0001','Rahim','01810000001','Mirpur',1000,current_date - 60,'active',null)).id as id`,
    )
  ).rows[0].id;
  const karim = (
    await db.query(
      `select (public.upsert_client(null,'C-0002','Karim','01810000002','Mirpur',1500,current_date - 60,'active',null)).id as id`,
    )
  ).rows[0].id;
  check("upsert_client created clients", Boolean(rahim && karim));

  const audit = await db.query(`select count(*)::int as n from public.audit_logs where action='client.created'`);
  check("client creation is audited", audit.rows[0].n === 2);

  await as(mama);
  await expectError(
    "collector cannot create a client",
    () => db.query(`select public.upsert_client(null,'C-0003','X',null,null,100,current_date,'active',null)`),
    "ADMIN_ONLY",
  );

  /* ---------------- Bill generation ---------------- */
  console.log("\n== Monthly bill generation ==");
  await as(abbu);
  const month = (await db.query(`select public.dhaka_current_month() as m`)).rows[0].m;
  const monthStr = month instanceof Date ? month.toISOString().slice(0, 10) : String(month).slice(0, 10);

  const gen1 = await db.query(`select * from public.generate_monthly_bills('${monthStr}')`);
  check("generated 2 bills", gen1.rows[0].created_count === 2, JSON.stringify(gen1.rows[0]));

  const gen2 = await db.query(`select * from public.generate_monthly_bills('${monthStr}')`);
  check(
    "re-running creates no duplicates",
    gen2.rows[0].created_count === 0 && gen2.rows[0].skipped_count === 2,
    JSON.stringify(gen2.rows[0]),
  );

  const billState = await db.query(
    `select c.name, b.bill_amount::float8 as bill, b.paid_amount::float8 as paid,
            b.due_amount::float8 as due, b.status
       from public.monthly_bills b join public.clients c on c.id=b.client_id
      order by c.name`,
  );
  check(
    "new bill: due = bill, status unpaid (every row)",
    billState.rows.length === 2 &&
      billState.rows.every((r) => r.due === r.bill && r.paid === 0 && r.status === "unpaid"),
    JSON.stringify(billState.rows),
  );

  await expectError(
    "cannot generate bills for a future month",
    () =>
      db.query(
        `select * from public.generate_monthly_bills(('${monthStr}'::date + interval '2 month')::date)`,
      ),
    "FUTURE_BILLING_MONTH",
  );

  /* ---------------- Acceptance test: full payment (spec 42) ---------------- */
  console.log("\n== Acceptance: Mama collects Rahim's full 1000 ==");
  await as(mama);
  await db.query(
    `select public.record_payment('${rahim}','${monthStr}',1000,'cash','Full payment',null)`,
  );

  const rahimBill = (
    await db.query(
      `select bill_amount::float8 b, paid_amount::float8 p, due_amount::float8 d, status
         from public.monthly_bills where client_id='${rahim}' and billing_month='${monthStr}'`,
    )
  ).rows[0];
  check(
    "Bill 1000 / Paid 1000 / Due 0 / status paid",
    rahimBill.b === 1000 && rahimBill.p === 1000 && rahimBill.d === 0 && rahimBill.status === "paid",
    JSON.stringify(rahimBill),
  );

  const mamaStats = (await db.query(`select public.collector_stats('${mama}') as s`)).rows[0].s;
  check("Mama total collection = 1000", Number(mamaStats.total_collection) === 1000, JSON.stringify(mamaStats));
  check("Mama unsubmitted = 1000", Number(mamaStats.unsubmitted) === 1000);

  await expectError(
    "cannot pay an already-paid bill",
    () => db.query(`select public.record_payment('${rahim}','${monthStr}',1,'cash',null,null)`),
    "BILL_ALREADY_PAID",
  );

  /* ---------------- Acceptance test: partial payment ---------------- */
  console.log("\n== Acceptance: Karim 1500 - Mama 1000 then Jamal 500 ==");
  await db.query(`select public.record_payment('${karim}','${monthStr}',1000,'cash',null,null)`);

  let karimBill = (
    await db.query(
      `select paid_amount::float8 p, due_amount::float8 d, status
         from public.monthly_bills where client_id='${karim}' and billing_month='${monthStr}'`,
    )
  ).rows[0];
  check(
    "after 1000 of 1500: Paid 1000 / Due 500 / partial",
    karimBill.p === 1000 && karimBill.d === 500 && karimBill.status === "partial",
    JSON.stringify(karimBill),
  );

  await expectError(
    "overpayment rejected with the due in the message",
    () => db.query(`select public.record_payment('${karim}','${monthStr}',600,'cash',null,null)`),
    "PAYMENT_EXCEEDS_DUE|500.00",
  );

  await as(jamal);
  await db.query(`select public.record_payment('${karim}','${monthStr}',500,'cash',null,null)`);

  karimBill = (
    await db.query(
      `select paid_amount::float8 p, due_amount::float8 d, status
         from public.monthly_bills where client_id='${karim}' and billing_month='${monthStr}'`,
    )
  ).rows[0];
  check(
    "after 500 more: Paid 1500 / Due 0 / paid",
    karimBill.p === 1500 && karimBill.d === 0 && karimBill.status === "paid",
    JSON.stringify(karimBill),
  );

  const payCount = await db.query(
    `select count(*)::int n from public.payments where client_id='${karim}'`,
  );
  check("both partial payments kept as separate transactions", payCount.rows[0].n === 2);

  const jamalStats = (await db.query(`select public.collector_stats('${jamal}') as s`)).rows[0].s;
  check("Jamal collection = 500", Number(jamalStats.total_collection) === 500);

  await expectError(
    "collector cannot read another collector's stats",
    () => db.query(`select public.collector_stats('${mama}') as s`),
    "ADMIN_ONLY",
  );

  await as(abbu);
  const mamaStats2 = (await db.query(`select public.collector_stats('${mama}') as s`)).rows[0].s;
  check("Mama collection = 2000 (1000 + 1000)", Number(mamaStats2.total_collection) === 2000);

  /* ---------------- Payment immutability ---------------- */
  console.log("\n== Payment immutability ==");
  const somePayment = (await db.query(`select id from public.payments limit 1`)).rows[0].id;

  await expectError(
    "payments cannot be deleted",
    () => db.query(`delete from public.payments where id='${somePayment}'`),
    "PAYMENT_DELETE_FORBIDDEN",
  );
  await expectError(
    "payment amount cannot be edited",
    () => db.query(`update public.payments set amount = 99999 where id='${somePayment}'`),
    "PAYMENT_IMMUTABLE",
  );

  /* ---------------- Cash submission ---------------- */
  console.log("\n== Cash submission ==");
  await as(mama);
  await expectError(
    "collector cannot record their own submission",
    () => db.query(`select public.create_cash_submission('${mama}',100,null,null)`),
    "ADMIN_ONLY",
  );

  await as(abbu);
  await expectError(
    "cannot submit more than collected",
    () => db.query(`select public.create_cash_submission('${mama}',5000,null,null)`),
    "SUBMISSION_EXCEEDS_COLLECTED|2000.00",
  );

  await db.query(`select public.create_cash_submission('${mama}',2000,null,'Full handover')`);
  const mamaStats3 = (await db.query(`select public.collector_stats('${mama}') as s`)).rows[0].s;
  check(
    "Mama: collected 2000, submitted 2000, unsubmitted 0",
    Number(mamaStats3.total_collection) === 2000 &&
      Number(mamaStats3.total_submitted) === 2000 &&
      Number(mamaStats3.unsubmitted) === 0,
    JSON.stringify(mamaStats3),
  );

  /* ---------------- Void ---------------- */
  console.log("\n== Void and reversal ==");
  const jamalPayment = (
    await db.query(`select id from public.payments where collected_by='${jamal}' limit 1`)
  ).rows[0].id;

  await as(jamal);
  await expectError(
    "collector cannot void a payment",
    () => db.query(`select public.void_payment('${jamalPayment}','oops')`),
    "ADMIN_ONLY",
  );

  await as(abbu);
  await expectError(
    "void requires a reason",
    () => db.query(`select public.void_payment('${jamalPayment}','')`),
    "VOID_REASON_REQUIRED",
  );

  await db.query(`select public.void_payment('${jamalPayment}','Entered twice')`);
  karimBill = (
    await db.query(
      `select paid_amount::float8 p, due_amount::float8 d, status
         from public.monthly_bills where client_id='${karim}' and billing_month='${monthStr}'`,
    )
  ).rows[0];
  check(
    "voiding restores the due: Paid 1000 / Due 500 / partial",
    karimBill.p === 1000 && karimBill.d === 500 && karimBill.status === "partial",
    JSON.stringify(karimBill),
  );

  const voidedRow = await db.query(
    `select voided_at is not null v, void_reason from public.payments where id='${jamalPayment}'`,
  );
  check(
    "voided payment is retained, not deleted",
    voidedRow.rows[0].v === true && voidedRow.rows[0].void_reason === "Entered twice",
  );

  await expectError(
    "cannot void twice",
    () => db.query(`select public.void_payment('${jamalPayment}','again')`),
    "PAYMENT_ALREADY_VOIDED",
  );

  /* ---------------- Constraints ---------------- */
  console.log("\n== Database constraints ==");
  await expectError(
    "duplicate bill for same client+month blocked",
    () =>
      db.query(
        `insert into public.monthly_bills(client_id,billing_month,bill_amount) values ('${rahim}','${monthStr}',1000)`,
      ),
    "monthly_bills_client_month_key",
  );
  await expectError(
    "negative payment rejected",
    () => db.query(`select public.record_payment('${karim}','${monthStr}',-5,'cash',null,null)`),
    "INVALID_AMOUNT",
  );
  await expectError(
    "future-dated payment rejected",
    () =>
      db.query(
        `select public.record_payment('${karim}','${monthStr}',10,'cash',null,(current_date + 5)::date)`,
      ),
    "FUTURE_PAYMENT_DATE",
  );
  await expectError(
    "payment against a month with no bill",
    () => db.query(`select public.record_payment('${karim}','2001-01-01',10,'cash',null,null)`),
    "BILL_NOT_FOUND",
  );
  await expectError(
    "client with payment history cannot be deleted",
    () => db.query(`select public.delete_client('${karim}')`),
    "CLIENT_HAS_PAYMENTS",
  );

  // paid_amount is a cache of the payment rows. Admins hold a write policy on
  // monthly_bills, so prove a direct write to it cannot desync the figure.
  await db.query(
    `update public.monthly_bills set paid_amount = 999999
      where client_id='${karim}' and billing_month='${monthStr}'`,
  );
  const tampered = (
    await db.query(
      `select paid_amount::float8 p, due_amount::float8 d, status
         from public.monthly_bills where client_id='${karim}' and billing_month='${monthStr}'`,
    )
  ).rows[0];
  check(
    "direct write to paid_amount is re-derived from the payments",
    tampered.p === 1000 && tampered.d === 500 && tampered.status === "partial",
    JSON.stringify(tampered),
  );

  await expectError(
    "a bill cannot be moved to another client",
    () =>
      db.query(
        `update public.monthly_bills set client_id='${rahim}'
          where client_id='${karim}' and billing_month='${monthStr}'`,
      ),
    "BILL_IMMUTABLE_KEY",
  );

  /* ---------------- Last-admin protection ---------------- */
  console.log("\n== Admin safety ==");
  await expectError(
    "admin cannot demote themselves",
    () => db.query(`select public.admin_update_profile('${abbu}','Abbu',null,'collector',true)`),
    "CANNOT_DEMOTE_SELF",
  );

  /* ---------------- RLS ---------------- */
  console.log("\n== Row Level Security (as the authenticated role) ==");
  await db.exec(`set role authenticated;`);

  await as(mama);
  const mamaSees = await db.query(`select count(*)::int n from public.payments`);
  check("collector sees only their own payments", mamaSees.rows[0].n === 2, JSON.stringify(mamaSees.rows[0]));

  const mamaProfiles = await db.query(`select count(*)::int n from public.profiles`);
  check("collector sees only their own profile", mamaProfiles.rows[0].n === 1);

  const mamaClients = await db.query(`select count(*)::int n from public.clients`);
  check("collector can read all clients", mamaClients.rows[0].n === 2);

  const mamaAudit = await db.query(`select count(*)::int n from public.audit_logs`);
  check("collector cannot read audit logs", mamaAudit.rows[0].n === 0);

  await expectError(
    "collector cannot insert a payment directly (no INSERT policy)",
    () =>
      db.query(
        `insert into public.payments(client_id,monthly_bill_id,amount,collected_by)
         select '${karim}', id, 50, '${mama}' from public.monthly_bills where client_id='${karim}' limit 1`,
      ),
    "row-level security",
  );

  // An RLS USING clause filters rows silently - it does not raise. So the
  // proof is that the UPDATE touches zero rows and the value is unchanged.
  const rogueUpdate = await db.query(
    `update public.clients set monthly_bill = 1 where id='${karim}'`,
  );
  const karimAfter = await db.query(
    `select monthly_bill::float8 mb from public.clients where id='${karim}'`,
  );
  check(
    "collector's client UPDATE affects 0 rows and changes nothing",
    (rogueUpdate.affectedRows ?? 0) === 0 && karimAfter.rows[0].mb === 1500,
    `affected=${rogueUpdate.affectedRows} monthly_bill=${karimAfter.rows[0].mb}`,
  );

  await expectError(
    "collector cannot insert a client (WITH CHECK)",
    () =>
      db.query(
        `insert into public.clients(client_code,name,monthly_bill) values ('X-9','Rogue',10)`,
      ),
    "row-level security",
  );

  await as(abbu);
  const abbuSees = await db.query(`select count(*)::int n from public.payments`);
  check("admin sees every payment", abbuSees.rows[0].n === 3, JSON.stringify(abbuSees.rows[0]));
  const abbuAudit = await db.query(`select count(*)::int n from public.audit_logs`);
  check("admin can read audit logs", abbuAudit.rows[0].n > 0);

  await db.exec(`reset role;`);

  /* ---------------- Reports ---------------- */
  console.log("\n== Reports and dashboard ==");
  await as(abbu);
  const summary = (await db.query(`select public.dashboard_summary('${monthStr}') as s`)).rows[0].s;
  check(
    "dashboard: billed 2500, collected 2000, due 500",
    Number(summary.billed_amount) === 2500 &&
      Number(summary.collected_amount) === 2000 &&
      Number(summary.due_amount) === 500,
    JSON.stringify(summary),
  );
  check("dashboard: 2 active clients", Number(summary.active_clients) === 2);
  check("dashboard: unsubmitted cash 0 after full handover", Number(summary.unsubmitted_cash) === 0,
    `got ${summary.unsubmitted_cash}`);

  const series = await db.query(`select * from public.monthly_series(6)`);
  check("monthly_series returns 6 months", series.rows.length === 6);

  const collectorSeries = await db.query(`select * from public.collector_series('${monthStr}', current_date)`);
  check(
    "collector_series lists collectors with payments",
    collectorSeries.rows.length === 1 && Number(collectorSeries.rows[0].total_amount) === 2000,
    JSON.stringify(collectorSeries.rows),
  );

  const daily = await db.query(`select * from public.daily_collection_report(current_date)`);
  check("daily report returns rows", daily.rows.length >= 1, JSON.stringify(daily.rows));

  /* ---------------- Summary ---------------- */
  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHarness crashed:", error.message);
  process.exit(1);
});
