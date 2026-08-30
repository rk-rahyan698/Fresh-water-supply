/**
 * Proves supabase/remove-demo-data.sql does what it claims.
 *
 *   npm run verify:cleanup
 *
 * Builds a throwaway database containing BOTH seeder-shaped demo data and
 * hand-made "real" data, runs the cleanup script against it, and checks that
 * every demo row is gone and every real row survives untouched.
 *
 * Worth doing before pointing that script at a production database: a cleanup
 * script that quietly takes one row too many is worse than no cleanup script.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const FILES = [
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

const as = (id) => db.exec(`select set_config('app.current_user_id', '${id ?? ""}', false);`);
const one = async (q) => (await db.query(q)).rows[0];
const count = async (table, where = "true") =>
  Number((await one(`select count(*)::int n from public.${table} where ${where}`)).n);

/** PGlite returns Date objects for `date` columns. */
const toDateStr = (v) =>
  v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);

/** Pulls STEP 2 (BEGIN..COMMIT) out of the cleanup script. */
function deletionBlock() {
  const sql = readFileSync(join(ROOT, "supabase", "remove-demo-data.sql"), "utf8");
  const start = sql.indexOf("BEGIN;");
  const end = sql.indexOf("COMMIT;") + "COMMIT;".length;
  if (start < 0 || end < start) throw new Error("Could not locate the BEGIN..COMMIT block");
  return sql.slice(start, end);
}

async function main() {
  await db.exec(`create role anon; create role authenticated; create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
                             raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('app.current_user_id', true), '')::uuid $$;`);
  for (const f of FILES) await db.exec(readFileSync(join(MIGRATIONS, `${f}.sql`), "utf8"));

  /* ---------------------------------------------------- demo data (seeder) */
  const abbu = randomUUID(), mama = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${abbu}','abbu@watersupply.demo','{"full_name":"Abbu (Owner)","role":"admin"}'),
    ('${mama}','mama@watersupply.demo','{"full_name":"Mama","role":"collector"}');`);
  await db.exec(`update public.profiles set email='abbu@watersupply.demo' where id='${abbu}';
                 update public.profiles set email='mama@watersupply.demo' where id='${mama}';`);
  await as(abbu);

  for (const name of ["Mirpur", "Kazipara", "Shewrapara", "Pallabi"]) {
    await db.query(`select public.upsert_area(null,'${name}',null,true)`);
  }
  const mirpur = (await one(`select id from public.areas where name='Mirpur'`)).id;

  const month = toDateStr((await one(`select public.dhaka_current_month() m`)).m);
  const mkDemo = async (idx, nm, amt) => (await one(
    `select (public.upsert_client(null,'C-${String(idx).padStart(4, "0")}','${nm}',
      '018100000${idx}',null,${amt},current_date - 60,'active',null,'${mirpur}')).id id`)).id;

  const demoIds = [];
  for (let i = 1; i <= 14; i++) demoIds.push(await mkDemo(i, `Demo Client ${i}`, 1000));

  /* ------------------------------------------------- real data (hand-made) */
  const owner = randomUUID();
  await db.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${owner}','real.owner@business.example','{"full_name":"Real Owner","role":"admin"}');`);
  await db.exec(`update public.profiles set email='real.owner@business.example' where id='${owner}';`);

  await as(owner);
  const realArea = (await one(`select (public.upsert_area(null,'Head Office',null,true)).id id`)).id;
  // client_code is UNIQUE, so a real client cannot reuse a demo code while the
  // demo rows exist. The interesting case - a real client that LATER gets a
  // demo-looking code - is covered at the end of this script.
  const realClient = (await one(
    `select (public.upsert_client(null,'C-0100','Real Client','01999888777',null,1500,
      current_date - 60,'active',null,'${realArea}')).id id`)).id;

  await db.query(`select * from public.generate_monthly_bills('${month}')`);

  // Demo payment by a demo collector, real payment by the real owner - the
  // shape the cleanup script expects.
  await as(mama);
  await db.query(`select public.record_payment('${demoIds[0]}','${month}',500,'cash','demo payment',null)`);
  await as(owner);
  await db.query(`select public.record_payment('${realClient}','${month}',700,'cash','real payment',null)`);

  const before = {
    clients: await count("clients"),
    bills: await count("monthly_bills"),
    payments: await count("payments"),
    areas: await count("areas"),
  };
  console.log("== Seeded ==");
  console.log(`  ${before.clients} clients (14 demo + 1 real), ${before.bills} bills, ${before.payments} payments, ${before.areas} areas`);

  /* ------------------------------------------------------ the safety check */
  console.log("\n== Payments really are undeletable without the trigger off ==");
  let blocked = false;
  try { await db.query(`delete from public.payments where client_id='${demoIds[0]}'`); }
  catch (e) { blocked = /PAYMENT_DELETE_FORBIDDEN/.test(String(e.message)); }
  check("a plain DELETE on payments is rejected", blocked,
    "the guard did not fire - the cleanup script's trigger toggle is the only way");

  /* ------------------------------------------------------------ run it */
  // Stage the dangerous case inside a transaction and roll it back, so the
  // guard is proven without leaving an undeletable payment behind.
  console.log("\n== The interlock refuses to lock you out ==");
  // Temporarily make the real owner a collector, so the only active admin is
  // the demo one - exactly the state this project was found in.
  await db.exec(`update public.profiles set role = 'collector' where id = '${owner}';`);
  let lockoutRefused = false;
  try {
    await db.exec(deletionBlock());
  } catch (e) {
    lockoutRefused = /only active admin is a demo account/.test(String(e.message));
  }
  // The failed BEGIN leaves the session in an aborted transaction; clear it.
  await db.exec("ROLLBACK").catch(() => {});
  check("aborts while the only admin is a demo account", lockoutRefused,
    "the lockout guard did not fire - running STEP 3 would strand the user");
  check("nothing was deleted by the aborted run",
    (await count("clients")) === 15, `${await count("clients")} clients left, expected 15`);

  // Restore the real admin and continue.
  await db.exec(`update public.profiles set role = 'admin' where id = '${owner}';`);
  check("a real admin makes the script runnable again",
    (await count("profiles", `role = 'admin' and is_active and email not like '%@watersupply.demo'`)) === 1);

  console.log("\n== The interlock refuses to delete real money ==");
  await db.exec("BEGIN");
  await as(owner);
  await db.query(`select public.record_payment('${demoIds[1]}','${month}',250,'cash','entangled',null)`);
  let refused = false;
  try {
    await db.exec(deletionBlock().replace("BEGIN;", "").replace("COMMIT;", ""));
  } catch (e) {
    refused = /Refusing to continue/.test(String(e.message));
  }
  await db.exec("ROLLBACK");
  check("a real user's payment on a demo client aborts the whole script", refused,
    "the interlock did not fire - real money could be deleted");
  check("the rollback left no entangled payment behind",
    (await count("payments", `notes = 'entangled'`)) === 0);

  console.log("\n== Running STEP 2 of remove-demo-data.sql ==");
  await db.exec(deletionBlock());
  console.log("  completed without error");

  /* ------------------------------------------------------------- verify */
  console.log("\n== Demo data gone ==");
  check("all 14 demo clients removed",
    (await count("clients", `client_code ~ '^C-00(0[1-9]|1[0-4])$' and phone ~ '^018100000[0-9]{1,2}$'`)) === 0);
  check("demo bills removed", (await count("monthly_bills")) === 1,
    `${await count("monthly_bills")} bills left, expected only the real one`);
  check("demo payment removed",
    (await count("payments", `notes = 'demo payment'`)) === 0);
  check("the four seeder areas removed",
    (await count("areas", `name in ('Mirpur','Kazipara','Shewrapara','Pallabi')`)) === 0);
  check("demo audit rows removed",
    (await count("audit_logs", `user_id = '${abbu}' or user_id = '${mama}'`)) === 0);

  console.log("\n== Real data untouched ==");
  const real = await one(`select client_code, name, phone from public.clients where id='${realClient}'`);
  check("the real client survives",
    real?.client_code === "C-0100" && real?.name === "Real Client", JSON.stringify(real));
  check("the real payment survives",
    (await count("payments", `notes = 'real payment'`)) === 1);
  check("the real payment kept its amount",
    Number((await one(`select amount::float8 a from public.payments where notes='real payment'`)).a) === 700);
  check("the real bill survives", (await count("monthly_bills", `client_id='${realClient}'`)) === 1);
  check("the hand-made area survives", (await count("areas", `name = 'Head Office'`)) === 1);
  check("the real admin profile survives", (await count("profiles", `id = '${owner}'`)) === 1);

  console.log("\n== The immutability guard is back on ==");
  let reblocked = false;
  try { await db.query(`delete from public.payments where notes='real payment'`); }
  catch (e) { reblocked = /PAYMENT_DELETE_FORBIDDEN/.test(String(e.message)); }
  check("payments are protected again after the script", reblocked,
    "TRIGGER LEFT DISABLED - real payments would be deletable");
  check("the real payment is still there", (await count("payments", `notes = 'real payment'`)) === 1);

  // Why the script matches on phone as well as code: once the demo rows are
  // gone, suggestClientCode() starts handing out C-0001 again, and a real
  // client with that code must never be caught by a re-run.
  console.log("\n== A real client that later gets a demo-looking code ==");
  await as(owner);
  await db.query(`select public.upsert_client(null,'C-0001','Brand New Real Client','01777666555',
    null,900,current_date,'active',null,'${realArea}')`);
  const wouldMatch = await count(
    "clients",
    `client_code ~ '^C-00(0[1-9]|1[0-4])$' and phone ~ '^018100000[0-9]{1,2}$'`,
  );
  check("a re-run would match 0 clients (the phone guard holds)", wouldMatch === 0,
    `${wouldMatch} would be deleted`);
  check("that new client is safe", (await count("clients", `client_code = 'C-0001'`)) === 1);

  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log("Failed:\n  - " + failures.join("\n  - "));
  console.log("=".repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nCrashed:", e.message); process.exit(1); });
