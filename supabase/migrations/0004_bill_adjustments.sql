-- =============================================================================
-- 0004_bill_adjustments.sql
-- Bill adjustments: discount / waiver / special reduction.
--
-- THE DISTINCTION THIS MIGRATION EXISTS FOR
--
--   Bill 1000, client pays 800, no adjustment   -> Due 200  (client still owes)
--   Bill 1000, adjustment 200, client pays 800  -> Due 0    (business waived it)
--
-- Both look like "paid 800 against a 1000 bill", but they mean opposite things.
-- Conflating them is how a paper ledger loses money.
--
-- APPROACH
--
-- `bill_amount` keeps its meaning: the ORIGINAL amount billed. We add
-- `adjustment_amount` and re-derive the generated columns:
--
--   adjusted_amount = bill_amount - adjustment_amount   (what is actually owed)
--   due_amount      = adjusted_amount - paid_amount
--   status          = derived from adjusted_amount vs paid_amount
--
-- Because due_amount and status keep their names and simply become
-- adjustment-aware, every existing query, report and dashboard tile stays
-- correct without being touched. Nothing is renamed.
--
-- Postgres will not let a generated column reference another generated column,
-- so adjusted_amount and due_amount are each written out from base columns.
--
-- Safe to re-run. Safe on a table that already holds bills and payments:
-- the dropped columns are derived, so no data is lost.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Adjustment type
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.adjustment_type as enum
    ('discount', 'waiver', 'special_reduction', 'other');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.monthly_bills
  add column if not exists adjustment_amount numeric(12,2) not null default 0,
  add column if not exists adjustment_type   public.adjustment_type,
  add column if not exists adjustment_reason text,
  add column if not exists adjusted_by       uuid references public.profiles(id) on delete restrict,
  add column if not exists adjusted_at       timestamptz;

-- ----------------------------------------------------------------------------
-- Re-derive the generated columns so they account for the adjustment.
-- They are derived values, so dropping and re-adding loses nothing.
-- ----------------------------------------------------------------------------
drop index if exists public.monthly_bills_due_idx;

alter table public.monthly_bills drop constraint if exists monthly_bills_no_overpayment;
alter table public.monthly_bills drop column if exists due_amount;
alter table public.monthly_bills drop column if exists status;
alter table public.monthly_bills drop column if exists adjusted_amount;

alter table public.monthly_bills
  add column adjusted_amount numeric(12,2)
    generated always as (bill_amount - adjustment_amount) stored,
  add column due_amount numeric(12,2)
    generated always as (bill_amount - adjustment_amount - paid_amount) stored,
  add column status public.bill_status generated always as (
    case
      when (bill_amount - adjustment_amount) <= 0 then 'paid'::public.bill_status
      when paid_amount <= 0 then 'unpaid'::public.bill_status
      when paid_amount >= (bill_amount - adjustment_amount) then 'paid'::public.bill_status
      else 'partial'::public.bill_status
    end
  ) stored;

create index if not exists monthly_bills_due_idx
  on public.monthly_bills (billing_month, due_amount)
  where due_amount > 0;

comment on column public.monthly_bills.bill_amount is
  'The ORIGINAL amount billed, before any adjustment.';
comment on column public.monthly_bills.adjustment_amount is
  'Discount / waiver applied by an admin. Reduces what the client owes.';
comment on column public.monthly_bills.adjusted_amount is
  'bill_amount - adjustment_amount. The amount actually payable.';

-- ----------------------------------------------------------------------------
-- Constraints (spec section 25, rules 3, 4 and 7)
-- ----------------------------------------------------------------------------
alter table public.monthly_bills
  drop constraint if exists monthly_bills_adjustment_range,
  drop constraint if exists monthly_bills_no_overpayment,
  drop constraint if exists monthly_bills_adjustment_metadata;

alter table public.monthly_bills
  -- Rule 3 + 4: an adjustment cannot exceed the bill, so the adjusted bill
  -- can never go negative.
  add constraint monthly_bills_adjustment_range
    check (adjustment_amount >= 0 and adjustment_amount <= bill_amount),
  -- Due can never go negative, now measured against the adjusted amount.
  add constraint monthly_bills_no_overpayment
    check (paid_amount <= bill_amount - adjustment_amount),
  -- Rule 7 + spec section 12: an adjustment always carries who and why.
  add constraint monthly_bills_adjustment_metadata
    check (
      (adjustment_amount = 0
        and adjustment_type is null
        and adjustment_reason is null
        and adjusted_by is null)
      or
      (adjustment_amount > 0
        and adjustment_type is not null
        and length(btrim(coalesce(adjustment_reason, ''))) > 0
        and adjusted_by is not null)
    );

-- ----------------------------------------------------------------------------
-- record_payment: due now comes from the adjusted amount.
-- Replaces the version in 0002; everything else about it is unchanged.
-- ----------------------------------------------------------------------------
create or replace function public.record_payment(
  p_client_id uuid,
  p_billing_month date,
  p_amount numeric,
  p_payment_method public.payment_method default 'cash',
  p_notes text default null,
  p_payment_date date default null
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := public.require_active();
  v_month   date := date_trunc('month', p_billing_month)::date;
  v_amount  numeric(12,2) := round(coalesce(p_amount, 0), 2);
  v_date    date := coalesce(p_payment_date, public.dhaka_today());
  v_bill    public.monthly_bills;
  v_due     numeric(12,2);
  v_payment public.payments;
begin
  if v_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  if v_date > public.dhaka_today() then
    raise exception 'FUTURE_PAYMENT_DATE' using errcode = '22023';
  end if;

  -- FOR UPDATE serialises concurrent collections against the same bill, which
  -- is what makes the overpayment check below race-free.
  select * into v_bill
    from public.monthly_bills
   where client_id = p_client_id
     and billing_month = v_month
   for update;

  if not found then
    raise exception 'BILL_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- due_amount is generated as (bill_amount - adjustment_amount - paid_amount),
  -- so a waived bill correctly reports nothing left to collect.
  v_due := v_bill.due_amount;

  if v_due <= 0 then
    raise exception 'BILL_ALREADY_PAID' using errcode = '22023';
  end if;

  if v_amount > v_due then
    raise exception 'PAYMENT_EXCEEDS_DUE|%', to_char(v_due, 'FM999999999.00')
      using errcode = '22023';
  end if;

  insert into public.payments (
    client_id, monthly_bill_id, amount, payment_date,
    payment_method, collected_by, notes
  )
  values (
    p_client_id, v_bill.id, v_amount, v_date,
    coalesce(p_payment_method, 'cash'), v_uid, nullif(btrim(p_notes), '')
  )
  returning * into v_payment;

  perform public.write_audit(
    'payment.created', 'payment', v_payment.id, null, to_jsonb(v_payment)
  );

  return v_payment;
end $fn$;

-- ----------------------------------------------------------------------------
-- update_bill_amount: the floor is now the adjusted amount, not the raw bill.
-- ----------------------------------------------------------------------------
create or replace function public.update_bill_amount(
  p_bill_id uuid,
  p_bill_amount numeric
)
returns public.monthly_bills
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.monthly_bills;
  v_new public.monthly_bills;
  v_amount numeric(12,2) := round(coalesce(p_bill_amount, 0), 2);
begin
  perform public.require_admin();

  if v_amount < 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  select * into v_old from public.monthly_bills where id = p_bill_id for update;
  if not found then
    raise exception 'BILL_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The new bill still has to cover its own adjustment.
  if v_amount < v_old.adjustment_amount then
    raise exception 'BILL_BELOW_ADJUSTMENT|%', to_char(v_old.adjustment_amount, 'FM999999999.00')
      using errcode = '22023';
  end if;

  -- ...and everything already collected against it.
  if (v_amount - v_old.adjustment_amount) < v_old.paid_amount then
    raise exception 'BILL_BELOW_PAID|%', to_char(v_old.paid_amount, 'FM999999999.00')
      using errcode = '22023';
  end if;

  update public.monthly_bills
     set bill_amount = v_amount
   where id = p_bill_id
  returning * into v_new;

  perform public.write_audit(
    'bill.updated', 'monthly_bill', p_bill_id, to_jsonb(v_old), to_jsonb(v_new)
  );

  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- set_bill_adjustment - admin only (spec section 13)
--
-- A collector must never be able to quietly reduce a bill, so this goes
-- through require_admin() and stamps adjusted_by from the JWT rather than
-- from the request body.
-- ----------------------------------------------------------------------------
create or replace function public.set_bill_adjustment(
  p_bill_id uuid,
  p_adjustment_amount numeric,
  p_adjustment_type public.adjustment_type,
  p_adjustment_reason text
)
returns public.monthly_bills
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid    uuid := public.require_admin();
  v_amount numeric(12,2) := round(coalesce(p_adjustment_amount, 0), 2);
  v_reason text := btrim(coalesce(p_adjustment_reason, ''));
  v_old    public.monthly_bills;
  v_new    public.monthly_bills;
begin
  if v_amount < 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  -- Spec section 12: never allow an adjustment without a reason.
  if v_amount > 0 and length(v_reason) = 0 then
    raise exception 'ADJUSTMENT_REASON_REQUIRED' using errcode = '22023';
  end if;

  if v_amount > 0 and p_adjustment_type is null then
    raise exception 'ADJUSTMENT_TYPE_REQUIRED' using errcode = '22023';
  end if;

  select * into v_old from public.monthly_bills where id = p_bill_id for update;
  if not found then
    raise exception 'BILL_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Rule 3: the adjustment cannot be larger than the bill itself.
  if v_amount > v_old.bill_amount then
    raise exception 'ADJUSTMENT_EXCEEDS_BILL|%', to_char(v_old.bill_amount, 'FM999999999.00')
      using errcode = '22023';
  end if;

  -- Cannot waive money that has already been collected - that would push the
  -- due negative. The owner must void a payment first.
  if (v_old.bill_amount - v_amount) < v_old.paid_amount then
    raise exception 'ADJUSTMENT_BELOW_PAID|%', to_char(v_old.bill_amount - v_old.paid_amount, 'FM999999999.00')
      using errcode = '22023';
  end if;

  update public.monthly_bills
     set adjustment_amount = v_amount,
         adjustment_type   = case when v_amount > 0 then p_adjustment_type else null end,
         adjustment_reason = case when v_amount > 0 then v_reason else null end,
         adjusted_by       = case when v_amount > 0 then v_uid else null end,
         adjusted_at       = case when v_amount > 0 then now() else null end
   where id = p_bill_id
  returning * into v_new;

  perform public.write_audit(
    case when v_amount > 0 then 'bill.adjustment_set' else 'bill.adjustment_removed' end,
    'monthly_bill', p_bill_id, to_jsonb(v_old), to_jsonb(v_new)
  );

  return v_new;
end $fn$;

-- Clearing an adjustment is just setting it to zero.
create or replace function public.remove_bill_adjustment(p_bill_id uuid)
returns public.monthly_bills
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  return public.set_bill_adjustment(p_bill_id, 0, null, null);
end $fn$;

-- ----------------------------------------------------------------------------
-- Reporting: surface the adjustment alongside the original and adjusted bill.
--
-- `billed_amount` now reports the ADJUSTED total, so the invariant the
-- dashboard relies on still holds:  collected + due = billed.
-- The original and the waived total are reported separately.
-- ----------------------------------------------------------------------------
create or replace function public.dashboard_summary(p_month date default null)
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
    'original_amount',   coalesce(sum(bill_amount), 0),
    'adjustment_amount', coalesce(sum(adjustment_amount), 0),
    'billed_amount',     coalesce(sum(adjusted_amount), 0),
    'collected_amount',  coalesce(sum(paid_amount), 0),
    'due_amount',        coalesce(sum(due_amount), 0),
    'bill_count',        count(*),
    'adjusted_count',    count(*) filter (where adjustment_amount > 0),
    'unpaid_count',      count(*) filter (where status = 'unpaid'),
    'partial_count',     count(*) filter (where status = 'partial'),
    'paid_count',        count(*) filter (where status = 'paid')
  )
  into v_bills
  from public.monthly_bills
  where billing_month = v_month;

  select jsonb_build_object(
    'received_in_month', coalesce(sum(amount) filter (where payment_date between v_month and v_end), 0),
    'received_today',    coalesce(sum(amount) filter (where payment_date = v_today), 0),
    'payments_today',    coalesce(count(*)   filter (where payment_date = v_today), 0),
    'payments_in_month', coalesce(count(*)   filter (where payment_date between v_month and v_end), 0)
  )
  into v_flow
  from public.payments
  where voided_at is null;

  select coalesce(
    (select sum(amount) from public.payments where voided_at is null and payment_method = 'cash'), 0
  ) - coalesce(
    (select sum(amount) from public.cash_submissions), 0
  )
  into v_cash;

  return jsonb_build_object(
    'billing_month', v_month,
    'today', v_today,
    'active_clients', (select count(*) from public.clients where status = 'active'),
    'inactive_clients', (select count(*) from public.clients where status = 'inactive'),
    'total_outstanding', coalesce((select sum(due_amount) from public.monthly_bills where due_amount > 0), 0),
    'unsubmitted_cash', v_cash
  ) || v_bills || v_flow;
end $fn$;

-- Chart series: billed is the adjusted total so the stacked bar
-- (collected + due) always equals the bar height.
-- The RETURNS TABLE signature gains two columns, and CREATE OR REPLACE cannot
-- change a return type, so this one has to be dropped first. The grant is
-- re-applied in the privileges block at the end of this file.
drop function if exists public.monthly_series(integer);

create function public.monthly_series(p_months integer default 6)
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
   group by m.m
   order by m.m;
end $fn$;

-- ----------------------------------------------------------------------------
-- Privileges for the new functions (0003 only knew about the old ones).
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
       and p.proname in ('set_bill_adjustment', 'remove_bill_adjustment', 'monthly_series')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
