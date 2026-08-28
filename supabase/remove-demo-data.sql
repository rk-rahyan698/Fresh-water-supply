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
-- 1. RUN STEP 1 ON ITS OWN and read the counts before running anything else.
--    If any number looks wrong, stop - do not run step 2.
--
-- 2. Payments normally CANNOT be deleted: the payments_guard trigger rejects
--    every DELETE, which is exactly what protects real financial history.
--    Step 2 switches that trigger off for the length of one transaction and
--    switches it straight back on. That is the only supported reason to do so.
--
-- 3. Step 2 is a single transaction. If anything fails, nothing is deleted.
--    To rehearse it, change the final COMMIT to ROLLBACK - you will see the
--    row counts it would have removed without changing anything.
--
-- 4. Auth users are removed last, in step 3, from the Supabase dashboard.
--
-- Demo rows are identified by the exact markers the seeder writes:
--     users    abbu@ / mama@ / jamal@watersupply.demo
--     clients  code C-0001..C-0014 AND phone 018100000xx  (both must match)
--     areas    Mirpur, Kazipara, Shewrapara, Pallabi
--
-- Requiring BOTH the code and the seeder phone number on a client is
-- deliberate: if you later create a real client that happens to be numbered
-- C-0007, it will not have a 018100000xx phone, so it is not touched.
-- =============================================================================


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
  (select count(*) from public.payments
     where client_id in (select id from demo_clients))                         as demo_payments,
  (select count(*) from public.cash_submissions
     where collector_id in (select id from demo_users))                        as demo_submissions,
  (select count(*) from public.client_rate_history
     where client_id in (select id from demo_clients))                         as demo_rate_rows,
  -- These two MUST be 0. Anything else means real work is entangled with the
  -- demo rows and would be destroyed - investigate before deleting.
  (select count(*) from public.payments
     where client_id in (select id from demo_clients)
       and collected_by not in (select id from demo_users))                     as real_user_payments_on_demo_clients,
  (select count(*) from public.payments
     where collected_by in (select id from demo_users)
       and client_id not in (select id from demo_clients))                      as demo_user_payments_on_real_clients,
  -- Totals, so you can confirm what survives.
  (select count(*) from public.clients)                                        as total_clients,
  (select count(*) from public.payments)                                       as total_payments;


-- =============================================================================
-- STEP 2 - THE DELETION.  Run only after step 1 looks right.
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

-- Safety interlock: refuse to run if a real user collected against a demo
-- client, because that payment is real money and would be destroyed here.
do $$
declare v_count integer;
begin
  select count(*) into v_count
    from public.payments
   where client_id in (select id from _demo_clients)
     and collected_by not in (select id from _demo_users);
  if v_count > 0 then
    raise exception
      'Refusing to continue: % payment(s) on demo clients were collected by a non-demo user. Investigate before deleting.', v_count;
  end if;
end $$;

-- Payments are immutable by design; this is the one sanctioned exception.
-- Re-enabled a few lines below, inside the same transaction.
alter table public.payments disable trigger payments_guard;

delete from public.payments where client_id in (select id from _demo_clients);

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
-- Do this from the dashboard rather than SQL, so Supabase cleans up its own
-- auth tables properly:
--
--   Authentication -> Users -> delete
--     abbu@watersupply.demo
--     mama@watersupply.demo
--     jamal@watersupply.demo
--
-- Deleting the auth user cascades to public.profiles automatically.
--
-- IMPORTANT: create your real admin account FIRST. admin_update_profile()
-- refuses to remove the last active admin, and you do not want to be locked
-- out of your own system.
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
  (select count(*) from public.profiles)            as profiles_left;
