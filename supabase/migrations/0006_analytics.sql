-- =============================================================================
-- 0006_analytics.sql
--
-- Reporting surface for areas, the client list, and long-term bill history.
--
-- ONE SOURCE OF TRUTH (spec section 30). Every function here derives the same
-- ladder from the same columns:
--
--     original   = bill_amount
--     adjustment = adjustment_amount
--     adjusted   = adjusted_amount        (generated: original - adjustment)
--     collected  = paid_amount            (trigger-maintained from payments)
--     due        = due_amount             (generated: adjusted - collected)
--
-- Nothing recomputes those in SQL or in TypeScript, so the dashboard, the area
-- report, the client profile and the monthly report cannot disagree.
--
-- The aggregate functions gain an optional p_area_id. Adding a parameter makes
-- a NEW signature rather than replacing the old one, so each is dropped first -
-- otherwise PostgREST is left choosing between two overloads.
--
-- Safe to re-run.
-- =============================================================================

-- Long-term history reads one client across many months; area reports read one
-- month across many clients. Index for both.
create index if not exists monthly_bills_month_status_idx
  on public.monthly_bills (billing_month, status);

-- ----------------------------------------------------------------------------
-- Which years does this client have bills for?  Powers the year selector, so
-- the matrix never has to load every bill just to find out (section 11).
-- ----------------------------------------------------------------------------
create or replace function public.client_bill_years(p_client_id uuid)
returns table (bill_year integer, bill_count bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.require_active();

  return query
  select extract(year from b.billing_month)::integer, count(*)
    from public.monthly_bills b
   where b.client_id = p_client_id
   group by 1
   order by 1 desc;
end $fn$;

-- ----------------------------------------------------------------------------
-- Year x Month bill matrix for one client (sections 6-11).
--
-- Returns a flat list bounded by a year range; the UI pivots it. Bounded on
-- purpose: a client with ten years of history should never ship 120 rows to
-- render three columns.
-- ----------------------------------------------------------------------------
create or replace function public.client_bill_matrix(
  p_client_id uuid,
  p_from_year integer default null,
  p_to_year integer default null
)
returns table (
  bill_id uuid,
  billing_month date,
  bill_year integer,
  bill_month integer,
  bill_amount numeric,
  adjustment_amount numeric,
  adjusted_amount numeric,
  paid_amount numeric,
  due_amount numeric,
  status public.bill_status,
  adjustment_type public.adjustment_type,
  adjustment_reason text,
  payment_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_to   integer := coalesce(p_to_year, extract(year from public.dhaka_today())::integer);
  v_from integer := coalesce(p_from_year, v_to - 2);
begin
  perform public.require_active();

  return query
  select b.id,
         b.billing_month,
         extract(year from b.billing_month)::integer,
         extract(month from b.billing_month)::integer,
         b.bill_amount,
         b.adjustment_amount,
         b.adjusted_amount,
         b.paid_amount,
         b.due_amount,
         b.status,
         b.adjustment_type,
         b.adjustment_reason,
         (select count(*) from public.payments p
           where p.monthly_bill_id = b.id and p.voided_at is null)
    from public.monthly_bills b
   where b.client_id = p_client_id
     and b.billing_month >= make_date(v_from, 1, 1)
     and b.billing_month <= make_date(v_to, 12, 1)
   order by b.billing_month;
end $fn$;

-- ----------------------------------------------------------------------------
-- Area-wise financial summary for one month (sections 21, 32).
--
-- Clients with no area are reported as "Unassigned" rather than dropped -
-- money must never vanish from a report because of a missing assignment.
-- ----------------------------------------------------------------------------
create or replace function public.area_summary(p_month date default null)
returns table (
  area_id uuid,
  area_name text,
  is_active boolean,
  client_count bigint,
  original_amount numeric,
  adjustment_amount numeric,
  adjusted_amount numeric,
  collected_amount numeric,
  due_amount numeric,
  paid_count bigint,
  partial_count bigint,
  unpaid_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month date := date_trunc('month', coalesce(p_month, public.dhaka_today()))::date;
begin
  perform public.require_admin();

  return query
  select a.id,
         a.name,
         a.is_active,
         count(distinct c.id),
         coalesce(sum(b.bill_amount), 0)::numeric,
         coalesce(sum(b.adjustment_amount), 0)::numeric,
         coalesce(sum(b.adjusted_amount), 0)::numeric,
         coalesce(sum(b.paid_amount), 0)::numeric,
         coalesce(sum(b.due_amount), 0)::numeric,
         count(b.id) filter (where b.status = 'paid'),
         count(b.id) filter (where b.status = 'partial'),
         count(b.id) filter (where b.status = 'unpaid')
    from public.areas a
    left join public.clients c on c.area_id = a.id and c.status = 'active'
    left join public.monthly_bills b on b.client_id = c.id and b.billing_month = v_month
   group by a.id, a.name, a.is_active

  union all

  select null::uuid,
         'Unassigned',
         true,
         count(distinct c.id),
         coalesce(sum(b.bill_amount), 0)::numeric,
         coalesce(sum(b.adjustment_amount), 0)::numeric,
         coalesce(sum(b.adjusted_amount), 0)::numeric,
         coalesce(sum(b.paid_amount), 0)::numeric,
         coalesce(sum(b.due_amount), 0)::numeric,
         count(b.id) filter (where b.status = 'paid'),
         count(b.id) filter (where b.status = 'partial'),
         count(b.id) filter (where b.status = 'unpaid')
    from public.clients c
    left join public.monthly_bills b on b.client_id = c.id and b.billing_month = v_month
   where c.area_id is null and c.status = 'active'
  having count(distinct c.id) > 0;
end $fn$;

-- ----------------------------------------------------------------------------
-- Client list with this month's figures attached (section 24).
--
-- One query instead of "list clients, then fetch each one's bill", which is
-- what keeps the page fast as the client count grows.
-- ----------------------------------------------------------------------------
create or replace function public.client_month_overview(
  p_month date default null,
  p_area_id uuid default null,
  p_search text default null,
  p_status public.client_status default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  client_id uuid,
  client_code text,
  name text,
  phone text,
  address text,
  area_id uuid,
  area_name text,
  monthly_bill numeric,
  client_status public.client_status,
  bill_id uuid,
  bill_amount numeric,
  adjustment_amount numeric,
  adjusted_amount numeric,
  paid_amount numeric,
  due_amount numeric,
  bill_status public.bill_status,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month  date := date_trunc('month', coalesce(p_month, public.dhaka_today()))::date;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  integer := greatest(1, least(coalesce(p_limit, 25), 200));
begin
  perform public.require_active();

  return query
  select c.id,
         c.client_code,
         c.name,
         c.phone,
         c.address,
         c.area_id,
         a.name,
         c.monthly_bill,
         c.status,
         b.id,
         b.bill_amount,
         b.adjustment_amount,
         b.adjusted_amount,
         b.paid_amount,
         b.due_amount,
         b.status,
         count(*) over ()
    from public.clients c
    left join public.areas a on a.id = c.area_id
    left join public.monthly_bills b on b.client_id = c.id and b.billing_month = v_month
   where (p_status is null or c.status = p_status)
     and (p_area_id is null or c.area_id = p_area_id)
     and (v_search is null or c.search_text ilike '%' || v_search || '%')
   order by c.name
   limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $fn$;

-- ----------------------------------------------------------------------------
-- Aggregates gain an optional area filter (sections 22, 23, 32).
-- Each is dropped first because adding a parameter changes the signature.
-- ----------------------------------------------------------------------------

drop function if exists public.dashboard_summary(date);
drop function if exists public.dashboard_summary(date, uuid);

create function public.dashboard_summary(
  p_month date default null,
  p_area_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month date := date_trunc('month', coalesce(p_month, public.dhaka_today()))::date;
  v_end   date := (date_trunc('month', coalesce(p_month, public.dhaka_today())) + interval '1 month - 1 day')::date;
  v_today date := public.dhaka_today();
  v_bills jsonb;
  v_flow  jsonb;
  v_cash  numeric;
begin
  perform public.require_admin();

  select jsonb_build_object(
    'original_amount',   coalesce(sum(b.bill_amount), 0),
    'adjustment_amount', coalesce(sum(b.adjustment_amount), 0),
    'billed_amount',     coalesce(sum(b.adjusted_amount), 0),
    'collected_amount',  coalesce(sum(b.paid_amount), 0),
    'due_amount',        coalesce(sum(b.due_amount), 0),
    'bill_count',        count(*),
    'adjusted_count',    count(*) filter (where b.adjustment_amount > 0),
    'unpaid_count',      count(*) filter (where b.status = 'unpaid'),
    'partial_count',     count(*) filter (where b.status = 'partial'),
    'paid_count',        count(*) filter (where b.status = 'paid')
  )
  into v_bills
  from public.monthly_bills b
  join public.clients c on c.id = b.client_id
  where b.billing_month = v_month
    and (p_area_id is null or c.area_id = p_area_id);

  select jsonb_build_object(
    'received_in_month', coalesce(sum(p.amount) filter (where p.payment_date between v_month and v_end), 0),
    'received_today',    coalesce(sum(p.amount) filter (where p.payment_date = v_today), 0),
    'payments_today',    coalesce(count(*)     filter (where p.payment_date = v_today), 0),
    'payments_in_month', coalesce(count(*)     filter (where p.payment_date between v_month and v_end), 0)
  )
  into v_flow
  from public.payments p
  join public.clients c on c.id = p.client_id
  where p.voided_at is null
    and (p_area_id is null or c.area_id = p_area_id);

  -- Unsubmitted cash is a collector-level figure, so it is never area-scoped.
  select coalesce(
    (select sum(amount) from public.payments where voided_at is null and payment_method = 'cash'), 0
  ) - coalesce(
    (select sum(amount) from public.cash_submissions), 0
  )
  into v_cash;

  return jsonb_build_object(
    'billing_month', v_month,
    'today', v_today,
    'area_id', p_area_id,
    'active_clients', (
      select count(*) from public.clients
       where status = 'active' and (p_area_id is null or area_id = p_area_id)
    ),
    'inactive_clients', (
      select count(*) from public.clients
       where status = 'inactive' and (p_area_id is null or area_id = p_area_id)
    ),
    'total_outstanding', coalesce((
      select sum(b.due_amount) from public.monthly_bills b
        join public.clients c on c.id = b.client_id
       where b.due_amount > 0 and (p_area_id is null or c.area_id = p_area_id)
    ), 0),
    'unsubmitted_cash', v_cash
  ) || v_bills || v_flow;
end $fn$;

drop function if exists public.monthly_series(integer);
drop function if exists public.monthly_series(integer, uuid);

create function public.monthly_series(
  p_months integer default 6,
  p_area_id uuid default null
)
returns table (
  billing_month date,
  original_amount numeric,
  adjustment_amount numeric,
  billed_amount numeric,
  collected_amount numeric,
  due_amount numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count integer := greatest(1, least(coalesce(p_months, 6), 24));
begin
  perform public.require_admin();

  return query
  with months as (
    select (date_trunc('month', public.dhaka_today()) - (offs || ' month')::interval)::date as m
      from generate_series(v_count - 1, 0, -1) as offs
  )
  select m.m,
         coalesce(sum(b.bill_amount), 0)::numeric,
         coalesce(sum(b.adjustment_amount), 0)::numeric,
         coalesce(sum(b.adjusted_amount), 0)::numeric,
         coalesce(sum(b.paid_amount), 0)::numeric,
         coalesce(sum(b.due_amount), 0)::numeric
    from months m
    left join public.monthly_bills b on b.billing_month = m.m
    left join public.clients c on c.id = b.client_id
   where (p_area_id is null or c.area_id = p_area_id or b.id is null)
   group by m.m
   order by m.m;
end $fn$;

drop function if exists public.collector_series(date, date);
drop function if exists public.collector_series(date, date, uuid);

create function public.collector_series(
  p_from date default null,
  p_to date default null,
  p_area_id uuid default null
)
returns table (
  collector_id uuid,
  collector_name text,
  payments_count bigint,
  total_amount numeric,
  cash_amount numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from date := coalesce(p_from, public.dhaka_current_month());
  v_to   date := coalesce(p_to, public.dhaka_today());
begin
  perform public.require_admin();

  return query
  select pr.id,
         pr.full_name,
         count(p.id),
         coalesce(sum(p.amount), 0)::numeric,
         coalesce(sum(p.amount) filter (where p.payment_method = 'cash'), 0)::numeric
    from public.profiles pr
    left join public.payments p
      on p.collected_by = pr.id
     and p.voided_at is null
     and p.payment_date between v_from and v_to
     and (p_area_id is null or exists (
           select 1 from public.clients c
            where c.id = p.client_id and c.area_id = p_area_id))
   group by pr.id, pr.full_name
  having count(p.id) > 0
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

drop function if exists public.daily_collection_report(date);
drop function if exists public.daily_collection_report(date, uuid);

create function public.daily_collection_report(
  p_date date default null,
  p_area_id uuid default null
)
returns table (
  collector_id uuid,
  collector_name text,
  payments_count bigint,
  total_amount numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_date date := coalesce(p_date, public.dhaka_today());
begin
  perform public.require_admin();

  return query
  select pr.id, pr.full_name, count(p.id), coalesce(sum(p.amount), 0)::numeric
    from public.payments p
    join public.profiles pr on pr.id = p.collected_by
    join public.clients c on c.id = p.client_id
   where p.voided_at is null
     and p.payment_date = v_date
     and (p_area_id is null or c.area_id = p_area_id)
   group by pr.id, pr.full_name
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

-- ----------------------------------------------------------------------------
-- Privileges - the dropped functions lost their grants with them.
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
         'dashboard_summary', 'monthly_series', 'collector_series',
         'daily_collection_report', 'area_summary', 'client_bill_matrix',
         'client_bill_years', 'client_month_overview'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
