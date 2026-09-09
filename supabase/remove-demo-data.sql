-- =============================================================================
-- remove-demo-data.sql
--
-- Deletes ONLY the rows created by `npm run seed`, leaving any real users,
-- clients, bills, payments, areas and audit history untouched.
--
-- ---------------------------------------------------------------------------
-- READ THIS FIRST
-- ---------------------------------------------------------------------------
--
-- 0. AS OF THE LAST CHECK, EVERY AUTH USER IN THIS PROJECT WAS A DEMO ACCOUNT,
--    INCLUDING THE ONLY ADMIN:
--
--        abbu@watersupply.demo    ca9df609-fb51-4e2e-b506-8278076f1b8c   admin
--        mama@watersupply.demo    71e9382d-1cf3-4b79-b302-8869aeb9e981   collector
--        jamal@watersupply.demo   4b167368-6999-45b8-94b7-9eb84c911420   collector
--
--    Deleting all three without creating a real admin first would lock you out
--    of the application with no way back in through the UI. STEP 0 exists to
--    prevent that, and STEP 2 refuses to run until it is done.
--
-- 1. Run STEP 1 on its own and read the counts before running anything else.
--    If any number looks wrong, stop - do not run STEP 2.
--
-- 2. Payments normally CANNOT be deleted: the payments_guard trigger rejects
--    every DELETE, which is exactly what protects real financial history.
--    STEP 2 switches that trigger off for the length of one transaction and
--    switches it straight back on. That is the only supported reason to do so.
--
-- 3. STEP 2 is a single transaction. If anything fails, nothing is deleted.
--    To rehearse it, change the final COMMIT to ROLLBACK - you will see it run
--    through without changing anything.
--
-- Demo rows are identified by the exact markers the seeder writes:
--     users    abbu@ / mama@ / jamal@watersupply.demo
--     clients  code C-0001..C-0014 AND phone 018100000xx  (both must match)
--     areas    Mirpur, Kazipara, Shewrapara, Pallabi
--
-- Requiring BOTH the code and the seeder phone on a client is deliberate: once
-- the demo rows are gone, suggestClientCode() starts handing out C-0001 again,
-- and a real client with that code must never be caught by a re-run.
-- =============================================================================


-- =============================================================================
-- STEP 0 - CREATE YOUR REAL ADMIN.  Do this before anything else.
--
-- Easiest route, through the app:
--
--   1. Sign in as abbu@watersupply.demo (the demo admin you have now).
--   2. Go to Users -> Add user.
--         Full name  your name
--         Email      your real email address
--         Password   your own, at least 8 characters
--         Role       Admin
--   3. Sign out. Sign in as the NEW account and confirm you can reach the
--      dashboard. Do not continue until you have actually signed in as it.
--
-- Alternative, through Supabase:
--   Authentication -> Users -> Add user (tick Auto Confirm), then
--   Table Editor -> profiles -> set that row's role to 'admin'.
--
-- Then run this to confirm a non-demo admin exists:
-- =============================================================================

select id, email, full_name, role, is_active
  from public.profiles
 where role = 'admin'
   and is_active
   and email not in ('abbu@watersupply.demo', 'mama@watersupply.demo', 'jamal@watersupply.demo');
-- Expect AT LEAST ONE row. If this returns nothing, STEP 2 will refuse to run.


-- =============================================================================
-- STEP 1 - DRY RUN.  Read-only. Run this alone and check the numbers.
-- =============================================================================

with demo_users as (
  select id from public.profiles
   where email in ('abbu@watersupply.demo', 'mama@watersupply.demo', 'jamal@watersupply.demo')
),
demo_clients as (
  select id from public.clients
   where client_code ~ '^C-00(0[1-9]|1[0-4])$'
     and phone ~ '^018100000[0-9]{1,2}$'
),
demo_areas as (
  select id from public.areas
   where name in ('Mirpur', 'Kazipara', 'Shewrapara', 'Pallabi')
)
select
  (select count(*) from demo_users)                                            as demo_users,
  (select count(*) from demo_clients)                                          as demo_clients,
  (select count(*) from demo_areas)                                            as demo_areas,
  (select count(*) from public.monthly_bills
     where client_id in (select id from demo_clients))                         as demo_bills,
  (select count(*) from public.payments p
     join public.monthly_bills b on b.id = p.monthly_bill_id
     where b.client_id in (select id from demo_clients))                       as demo_payments,
  (select count(*) from public.cash_submissions
     where collector_id in (select id from demo_users))                        as demo_submissions,
  (select count(*) from public.client_rate_history
     where client_id in (select id from demo_clients))                         as demo_rate_rows,
  -- MUST BE >= 1, or STEP 2 aborts to stop you locking yourself out.
  (select count(*) from public.profiles
     where role = 'admin' and is_active
       and email not in ('abbu@watersupply.demo', 'mama@watersupply.demo', 'jamal@watersupply.demo'))
                                                                               as real_admins_remaining,
  -- These two MUST be 0. Anything else means real work is entangled with the
  -- demo rows and would be destroyed - investigate before deleting.
  (select count(*) from public.payments p
     join public.monthly_bills b on b.id = p.monthly_bill_id
     where b.client_id in (select id from demo_clients)
       and p.collected_by not in (select id from demo_users))                   as real_user_payments_on_demo_clients,
  (select count(*) from public.payments p
     join public.monthly_bills b on b.id = p.monthly_bill_id
     where p.collected_by in (select id from demo_users)
       and b.client_id not in (select id from demo_clients))                    as demo_user_payments_on_real_clients,
  -- Totals, so you can confirm what survives.
  (select count(*) from public.clients)                                        as total_clients,
  (select count(*) from public.payments)                                       as total_payments;


-- =============================================================================
-- STEP 2 - THE DELETION.  Run only after STEP 0 and STEP 1 look right.
--
-- Select from BEGIN to COMMIT and run it as one statement.
-- =============================================================================

BEGIN;

-- Resolve the demo rows once, so every delete below agrees on the same set
-- even though the tables change underneath.
create temporary table _demo_users on commit drop as
  select id from public.profiles
   where email in ('abbu@watersupply.demo', 'mama@watersupply.demo', 'jamal@watersupply.demo');

create temporary table _demo_clients on commit drop as
  select id from public.clients
   where client_code ~ '^C-00(0[1-9]|1[0-4])$'
     and phone ~ '^018100000[0-9]{1,2}$';

create temporary table _demo_bills on commit drop as
  select id from public.monthly_bills where client_id in (select id from _demo_clients);

-- Interlock 1: refuse to proceed unless a real admin already exists.
--
-- STEP 3 asks you to delete every demo login. If the demo admin is still the
-- only admin at that point, the application becomes unreachable - no UI path
-- creates the first admin. Better to stop here than to find out afterwards.
do $$
declare v_admins integer;
begin
  select count(*) into v_admins
    from public.profiles
   where role = 'admin'
     and is_active
     and email not in ('abbu@watersupply.demo', 'mama@watersupply.demo', 'jamal@watersupply.demo');
  if v_admins = 0 then
    raise exception
      'Refusing to continue: the only active admin is a demo account. Complete STEP 0 (create a real admin and sign in as it) first, or you will lock yourself out.';
  end if;
end $$;

-- Interlock 2: refuse if a real user collected against a demo client, because
-- that payment is real money and would be destroyed here.
do $$
declare v_count integer;
begin
  select count(*) into v_count
    from public.payments p
    join public.monthly_bills b on b.id = p.monthly_bill_id
   where b.client_id in (select id from _demo_clients)
     and p.collected_by not in (select id from _demo_users);
  if v_count > 0 then
    raise exception
      'Refusing to continue: % payment(s) on demo clients were collected by a non-demo user. Investigate before deleting.', v_count;
  end if;
end $$;

-- Payments are immutable by design; this is the one sanctioned exception.
-- Re-enabled a few lines below, inside the same transaction.
alter table public.payments disable trigger payments_guard;

delete from public.payments p
 using public.monthly_bills b
 where b.id = p.monthly_bill_id
   and b.client_id in (select id from _demo_clients);

alter table public.payments enable trigger payments_guard;

delete from public.cash_submissions where collector_id in (select id from _demo_users);
delete from public.client_rate_history where client_id in (select id from _demo_clients);
delete from public.monthly_bills where client_id in (select id from _demo_clients);
delete from public.clients where id in (select id from _demo_clients);

-- Only the four areas the seeder made. An area you created yourself - for
-- example "area1" - is left alone. Any area still holding a client is also
-- left alone, because the foreign key would refuse anyway.
delete from public.areas
 where name in ('Mirpur', 'Kazipara', 'Shewrapara', 'Pallabi')
   and id not in (select area_id from public.clients where area_id is not null);

-- Audit rows for the demo activity. audit_logs.user_id is ON DELETE SET NULL,
-- so these would otherwise linger as orphaned entries.
delete from public.audit_logs
 where user_id in (select id from _demo_users)
    or entity_id in (select id from _demo_clients)
    or entity_id in (select id from _demo_bills);

-- Change to ROLLBACK to rehearse without deleting anything.
COMMIT;


-- =============================================================================
-- STEP 3 - REMOVE THE DEMO LOGINS
--
-- Only after STEP 2 has committed and you have signed in as your real admin.
--
-- Supabase dashboard -> Authentication -> Users -> delete all three:
--
--     abbu@watersupply.demo    ca9df609-fb51-4e2e-b506-8278076f1b8c
--     mama@watersupply.demo    71e9382d-1cf3-4b79-b302-8869aeb9e981
--     jamal@watersupply.demo   4b167368-6999-45b8-94b7-9eb84c911420
--
-- Deleting the auth user cascades to public.profiles automatically.
--
-- If a delete is refused, something still references that profile - most
-- likely a payment they collected, since payments.collected_by is ON DELETE
-- RESTRICT. That is the database protecting real history: leave that account
-- in place and deactivate it instead (Users -> Edit -> Status: Inactive).
--
-- Finally, remove SEED_PASSWORD from .env.local so the demo password is not
-- left lying around.
-- =============================================================================


-- =============================================================================
-- STEP 4 - VERIFY
-- =============================================================================

select
  (select count(*) from public.clients)             as clients_left,
  (select count(*) from public.monthly_bills)       as bills_left,
  (select count(*) from public.payments)            as payments_left,
  (select count(*) from public.cash_submissions)    as submissions_left,
  (select count(*) from public.areas)               as areas_left,
  (select count(*) from public.profiles)            as profiles_left,
  (select count(*) from public.profiles
    where role = 'admin' and is_active)             as active_admins;
-- active_admins must be >= 1, and it should be YOUR account.
