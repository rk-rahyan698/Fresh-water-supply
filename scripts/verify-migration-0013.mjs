/**
 * Verifies 0013_staff_names.sql.
 *
 *   npm run verify:staffnames
 *
 * A collector's "Received by" column was blank: profiles RLS lets them read
 * only their own row, so the owner's name embedded as null. This proves:
 *
 *   1. RLS really does hide the owner's profile from a collector (the bug).
 *   2. staff_names() gives that collector the owner's name - and only the name.
 *   3. Deactivated staff still resolve, so old records keep their names.
 *   4. Empty, null and unknown ids are harmless.
 *   5. Signed-out and deactivated callers are refused, anon cannot execute it,
 *      and setup.sql still re-runs cleanly.
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
  "0012_client_overview_bill_filter", "0013_staff_names",
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

  console.log("== Applying 0001-0013 ==");
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
      where nsp.nspname='public' and p.proname='staff_names'`);
    check("staff_names(): exactly one overload", Number(r.c) === 1, `found ${r.c}`);
    check("staff_names(): anon denied, authenticated allowed", r.a === false && r.au === true);
  }

  /* ------------------------------------------------------------- fixtures */
  const abbu = randomUUID(), mama = randomUUID(), chacha = randomUUID();
  await db.exec(`insert into auth.users (id,email,phone,raw_user_meta_data) values
    ('${abbu}','abbu@t.test','01700000001','{"full_name":"Abbu","role":"admin"}'),
    ('${mama}','mama@t.test','01700000002','{"full_name":"Mama","role":"collector"}'),
    ('${chacha}','chacha@t.test','01700000003','{"full_name":"Chacha","role":"collector"}');`);
  await db.exec(`update public.profiles set is_active = false where id = '${chacha}'`);

  const names = async (ids) =>
    rows(`select * from public.staff_names(${ids === null ? "null" : `array[${ids.map((i) => `'${i}'`).join(",")}]::uuid[]`})`);

  /* ------------------------------------------------------------- the bug */
  console.log("\n== RLS hides the owner's profile from a collector ==");
  await db.exec(`set role authenticated`);
  await as(mama);
  const visible = await rows(`select id from public.profiles`);
  check("a collector reads only their own profile row",
    visible.length === 1 && visible[0].id === mama, `${visible.length} rows`);
  await db.exec(`reset role`);

  /* ------------------------------------------------------------- the fix */
  console.log("\n== staff_names() fills the gap ==");
  await db.exec(`set role authenticated`);
  await as(mama);
  const got = await names([abbu, mama]);
  const byId = new Map(got.map((r) => [r.id, r.full_name]));
  check("a collector gets the owner's name", byId.get(abbu) === "Abbu", JSON.stringify(got));
  check("...and their own", byId.get(mama) === "Mama");
  check("only the ids asked for", got.length === 2);
  check("names only: no email, phone or role comes back",
    Object.keys(got[0] ?? {}).sort().join() === "full_name,id", Object.keys(got[0] ?? {}).join());
  check("a deactivated collector still resolves, so old records keep their name",
    (await names([chacha]))[0]?.full_name === "Chacha");
  check("RLS on profiles is unchanged: still one row",
    (await rows(`select id from public.profiles`)).length === 1);
  await db.exec(`reset role`);

  console.log("\n== Input handling ==");
  await as(mama);
  check("an empty array returns nothing", (await names([])).length === 0);
  check("null returns nothing", (await names(null)).length === 0);
  check("an unknown id returns nothing", (await names([randomUUID()])).length === 0);
  check("a repeated id returns one row", (await names([abbu, abbu])).length === 1);

  console.log("\n== Access ==");
  await as(abbu);
  check("the owner can call it too", (await names([mama]))[0]?.full_name === "Mama");
  await as(null);
  await expectError("signed out: refused", () => names([abbu]), "AUTH_REQUIRED");
  await as(chacha);
  await expectError("a deactivated user: refused", () => names([abbu]), "USER_INACTIVE");
  await as(abbu);

  /* ------------------------------------------------------ setup.sql re-run */
  console.log("\n== setup.sql is safe to apply a second time ==");
  try {
    await db.exec(readFileSync(SETUP, "utf8"));
    check("setup.sql re-applies on a migrated database", true);
  } catch (e) {
    check("setup.sql re-applies on a migrated database", false, e.message);
  }
  const overloads = await one(`select count(*) c from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public' and p.proname = 'staff_names'`);
  check("...leaving one staff_names()", Number(overloads.c) === 1, `found ${overloads.c}`);
  await as(mama);
  check("...which still answers", (await names([abbu]))[0]?.full_name === "Abbu");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`Failed: ${failures.join(", ")}`);
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
