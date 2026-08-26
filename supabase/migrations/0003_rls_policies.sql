-- =============================================================================
-- 0003_rls_policies.sql
-- Row Level Security.
--
-- Note what is deliberately absent: payments and cash_submissions have NO
-- insert/update/delete policies. PostgREST therefore cannot write them at all.
-- The only way money moves is through the SECURITY DEFINER functions in 0002,
-- which re-check the caller's role and write an audit row in the same
-- transaction.
-- =============================================================================

alter table public.profiles         enable row level security;
alter table public.clients          enable row level security;
alter table public.monthly_bills    enable row level security;
alter table public.payments         enable row level security;
alter table public.cash_submissions enable row level security;
alter table public.audit_logs       enable row level security;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

-- Self-service edits go through update_own_profile() so a collector can never
-- set their own role to admin.
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert on public.profiles
  for insert to authenticated
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- clients - every active user may read (collectors need to find clients),
-- only admins may write, and writes go through upsert_client() for auditing.
-- ----------------------------------------------------------------------------
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select to authenticated
  using (public.is_active_user());

drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- monthly_bills - readable by any active user, writable only by admins.
-- (paid_amount is still maintained solely by the trigger.)
-- ----------------------------------------------------------------------------
drop policy if exists monthly_bills_select on public.monthly_bills;
create policy monthly_bills_select on public.monthly_bills
  for select to authenticated
  using (public.is_active_user());

drop policy if exists monthly_bills_admin_write on public.monthly_bills;
create policy monthly_bills_admin_write on public.monthly_bills
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- payments - admins see everything; a collector sees only what they collected.
-- No write policies: record_payment() / void_payment() are the only doors.
-- ----------------------------------------------------------------------------
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (public.is_admin() or collected_by = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- cash_submissions - admins see everything, collectors see their own record.
-- ----------------------------------------------------------------------------
drop policy if exists cash_submissions_select on public.cash_submissions;
create policy cash_submissions_select on public.cash_submissions
  for select to authenticated
  using (public.is_admin() or collector_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- audit_logs - admin read only; rows are written by SECURITY DEFINER functions.
-- ----------------------------------------------------------------------------
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (public.is_admin());

-- ----------------------------------------------------------------------------
-- Function privileges
--
-- Postgres grants EXECUTE to PUBLIC by default, which would expose these to the
-- anon role. Lock them to authenticated users only.
-- ----------------------------------------------------------------------------
do $grants$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'record_payment', 'void_payment',
         'generate_monthly_bills', 'generate_client_bill', 'update_bill_amount',
         'create_cash_submission', 'collector_stats',
         'dashboard_summary', 'monthly_series', 'collector_series',
         'daily_collection_report', 'collector_daily_breakdown',
         'update_own_profile', 'admin_update_profile',
         'upsert_client', 'set_client_status', 'delete_client',
         'is_admin', 'is_active_user', 'current_user_role',
         'require_active', 'require_admin', 'write_audit',
         'dhaka_today', 'dhaka_current_month'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;

-- write_audit and the require_* helpers are internal plumbing: they should not
-- be callable over the REST API even by a signed-in user.
revoke execute on function public.write_audit(text, text, uuid, jsonb, jsonb) from authenticated;
revoke execute on function public.require_active() from authenticated;
revoke execute on function public.require_admin() from authenticated;

-- The anon role never needs table access; auth happens before anything else.
revoke all on all tables in schema public from anon;
