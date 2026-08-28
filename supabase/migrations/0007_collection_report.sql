-- =============================================================================
-- 0007_collection_report.sql
--
-- The all-clients Client x Month collection report.
--
-- WHAT A CELL MEANS (spec section 9)
--
-- Each cell is the money ACTUALLY COLLECTED in that calendar month, keyed on
-- payment_date - not the bill amount, and not moved back to the month the bill
-- belongs to. A client billed 1000 in March who pays 800 in March and 200 in
-- April shows 800 under March and 200 under April.
--
-- That is deliberately a different question from the bill-month ladder the
-- dashboard shows, and both are derived from the same rows.
--
-- PERFORMANCE (section 24)
--
-- The pivot happens in SQL: one row per client, twelve numeric columns. The
-- browser never sees individual payments. The year filter is written as a
-- date range rather than extract(year from ...) so the existing
-- payments_date_idx / payments_active_idx are usable.
--
-- Safe to re-run.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Years that actually have payments - drives the year selector, so no year is
-- ever hardcoded (section 10).
-- ----------------------------------------------------------------------------
create or replace function public.payment_years()
returns table (payment_year integer, payment_count bigint, total_amount numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.require_admin();

  return query
  select extract(year from p.payment_date)::integer,
         count(*),
         coalesce(sum(p.amount), 0)::numeric
    from public.payments p
   where p.voided_at is null
   group by 1
   order by 1 desc;
end $fn$;

-- ----------------------------------------------------------------------------
-- Client x Month collection matrix for one year (sections 6-8, 11, 15-18).
--
-- Returns every client that matches the filters, including those who paid
-- nothing - a client with no payments is a meaningful row in a collection
-- report, and section 18 asks for 0 rather than a blank.
-- ----------------------------------------------------------------------------
create or replace function public.collection_matrix(
  p_year integer,
  p_area_id uuid default null,
  p_collector_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  client_name text,
  area_id uuid,
  area_name text,
  m01 numeric, m02 numeric, m03 numeric, m04 numeric, m05 numeric, m06 numeric,
  m07 numeric, m08 numeric, m09 numeric, m10 numeric, m11 numeric, m12 numeric,
  year_total numeric,
  payment_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from date := make_date(p_year, 1, 1);
  v_to   date := make_date(p_year, 12, 31);
begin
  perform public.require_admin();

  return query
  select c.id,
         c.client_code,
         c.name,
         c.area_id,
         a.name,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 1), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 2), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 3), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 4), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 5), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 6), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 7), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 8), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 9), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 10), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 11), 0)::numeric,
         coalesce(sum(p.amount) filter (where extract(month from p.payment_date) = 12), 0)::numeric,
         coalesce(sum(p.amount), 0)::numeric,
         count(p.id)
    from public.clients c
    left join public.areas a on a.id = c.area_id
    -- Left join, and every payment predicate lives in the ON clause: a WHERE
    -- on p.* would silently turn this into an inner join and drop the clients
    -- who paid nothing.
    left join public.payments p
      on p.client_id = c.id
     and p.voided_at is null
     and p.payment_date between v_from and v_to
     and (p_collector_id is null or p.collected_by = p_collector_id)
   where (p_area_id is null or c.area_id = p_area_id)
   group by c.id, c.client_code, c.name, c.area_id, a.name
   order by c.name;
end $fn$;

-- ----------------------------------------------------------------------------
-- Headline figures for the same filters (section 13).
--
-- Collection figures follow payment_date; the bill ladder follows billing
-- month. Both are reported, and each is labelled for what it is - mixing the
-- two bases in one number is how a report starts lying.
-- ----------------------------------------------------------------------------
create or replace function public.collection_summary(
  p_year integer,
  p_area_id uuid default null,
  p_collector_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_from    date := make_date(p_year, 1, 1);
  v_to      date := make_date(p_year, 12, 31);
  v_flow    jsonb;
  v_bills   jsonb;
begin
  perform public.require_admin();

  -- Collected, on a payment-date basis.
  select jsonb_build_object(
    'total_collected',   coalesce(sum(p.amount), 0),
    'payment_count',     count(p.id),
    'paying_clients',    count(distinct p.client_id),
    'average_payment',   case when count(p.id) > 0
                              then round(coalesce(sum(p.amount), 0) / count(p.id), 2)
                              else 0 end
  )
  into v_flow
  from public.payments p
  join public.clients c on c.id = p.client_id
  where p.voided_at is null
    and p.payment_date between v_from and v_to
    and (p_area_id is null or c.area_id = p_area_id)
    and (p_collector_id is null or p.collected_by = p_collector_id);

  -- Billed / adjusted / due for the same year, on a billing-month basis.
  -- The collector filter does not apply here: a bill is not collected by
  -- anybody until a payment exists.
  select jsonb_build_object(
    'original_amount',   coalesce(sum(b.bill_amount), 0),
    'adjustment_amount', coalesce(sum(b.adjustment_amount), 0),
    'adjusted_amount',   coalesce(sum(b.adjusted_amount), 0),
    'billed_collected',  coalesce(sum(b.paid_amount), 0),
    'outstanding',       coalesce(sum(b.due_amount), 0),
    'bill_count',        count(b.id)
  )
  into v_bills
  from public.monthly_bills b
  join public.clients c on c.id = b.client_id
  where b.billing_month between v_from and v_to
    and (p_area_id is null or c.area_id = p_area_id);

  return jsonb_build_object(
    'year', p_year,
    'area_id', p_area_id,
    'collector_id', p_collector_id,
    'client_count', (
      select count(*) from public.clients c
       where (p_area_id is null or c.area_id = p_area_id)
    )
  ) || v_flow || v_bills;
end $fn$;

-- ----------------------------------------------------------------------------
-- One client's full payment history, for the profile and the PDF export
-- (sections 2C, 3). Ordered newest first.
--
-- require_active, not require_admin: a collector may open a client they are
-- collecting from. RLS still narrows payments to the ones they took.
-- ----------------------------------------------------------------------------
create or replace function public.client_payment_history(
  p_client_id uuid,
  p_year integer default null,
  p_limit integer default 500
)
returns table (
  payment_id uuid,
  receipt_no bigint,
  billing_month date,
  payment_date date,
  amount numeric,
  payment_method public.payment_method,
  collector_name text,
  notes text,
  voided boolean,
  void_reason text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.require_active();

  return query
  select p.id,
         p.receipt_no,
         b.billing_month,
         p.payment_date,
         p.amount,
         p.payment_method,
         pr.full_name,
         p.notes,
         p.voided_at is not null,
         p.void_reason
    from public.payments p
    join public.monthly_bills b on b.id = p.monthly_bill_id
    left join public.profiles pr on pr.id = p.collected_by
   where p.client_id = p_client_id
     and (p_year is null or extract(year from p.payment_date)::integer = p_year)
     -- RLS is bypassed inside a SECURITY DEFINER function, so the collector
     -- restriction that payments_select would apply is re-stated here.
     and (public.is_admin() or p.collected_by = auth.uid())
   order by p.payment_date desc, p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 2000));
end $fn$;

-- ----------------------------------------------------------------------------
-- Lifetime totals for one client, for the PDF summary block (section 3).
-- ----------------------------------------------------------------------------
create or replace function public.client_financial_summary(
  p_client_id uuid,
  p_year integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_bills jsonb;
  v_paid  numeric;
begin
  perform public.require_active();

  select jsonb_build_object(
    'original_amount',   coalesce(sum(b.bill_amount), 0),
    'adjustment_amount', coalesce(sum(b.adjustment_amount), 0),
    'adjusted_amount',   coalesce(sum(b.adjusted_amount), 0),
    'collected_amount',  coalesce(sum(b.paid_amount), 0),
    'outstanding',       coalesce(sum(b.due_amount), 0),
    'bill_count',        count(*)
  )
  into v_bills
  from public.monthly_bills b
  where b.client_id = p_client_id
    and (p_year is null or extract(year from b.billing_month)::integer = p_year);

  select coalesce(sum(p.amount), 0) into v_paid
    from public.payments p
   where p.client_id = p_client_id
     and p.voided_at is null
     and (p_year is null or extract(year from p.payment_date)::integer = p_year)
     and (public.is_admin() or p.collected_by = auth.uid());

  return jsonb_build_object('year', p_year, 'paid_in_period', v_paid) || v_bills;
end $fn$;

-- ----------------------------------------------------------------------------
-- Privileges
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
         'payment_years', 'collection_matrix', 'collection_summary',
         'client_payment_history', 'client_financial_summary'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
