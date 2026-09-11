-- =============================================================================
-- 0010_multi_month_collection.sql
-- One payment across several unpaid months, the actual monthly bill per
-- client for the collection report, and rate changes that can reach the
-- month already billed.
--
-- PART 1 - record_collection()
--
--   A client owing July, August and September hands over one amount. Until
--   now the app could only record a payment against a single bill, capped at
--   that bill's due, and the admin screens only offered the current month at
--   all - so the money could not be entered as it was received.
--
--   A payment still belongs to exactly one bill. That is what keeps
--   paid_amount, due_amount and status exact, and it does not change here. A
--   collection that spans three months is recorded as three payment rows, one
--   per bill, written by record_payment() so every existing rule applies to
--   each of them unchanged: the row lock, the overpayment check, collected_by
--   stamped from the JWT, the audit entry.
--
--   What is new is that they are written together. This function is one
--   statement, so it is one transaction: if the third month would be
--   overpaid, the first two are not recorded either. Calling record_payment()
--   three times from the application would give three transactions and could
--   leave a collection half-written.
--
--   Months are locked and written oldest first, in billing-month order, so two
--   concurrent collections for the same client always take their locks in the
--   same order and cannot deadlock each other.
--
--   The rows of one collection share created_at exactly: now() is the start
--   time of the transaction, not of the statement, so every insert inside
--   this function stamps the same value. The receipt uses that - together with
--   the collector and the client - to print one receipt for the whole
--   collection, with no grouping column that would duplicate the date, method
--   and collector already stored on every row.
--
-- PART 2 - collection_bill_months()
--
--   The collection report shows what each client PAID per month and had no
--   way to show what they were BILLED. A single "monthly bill" figure would be
--   wrong for any client whose rate changed during the year, so this returns
--   the amount actually billed for each of the twelve months - taken from
--   monthly_bills, not from client_rate_history, because the bill is what the
--   client owes and a bill can differ from the rate (an edited month, or a
--   rate change that arrived after the month was generated).
--
--   bill_amount, not adjusted_amount: a one-off discount is not a change to
--   the client's monthly bill, and must not look like one.
--
--   A separate function rather than extra columns on collection_matrix():
--   changing that function's return type would require DROP + CREATE here, and
--   then re-running setup.sql would fail at 0008, whose CREATE OR REPLACE
--   still declares the old shape. setup.sql is documented as safe to re-run.
--
-- PART 3 - change_client_rate()
--
--   The rate dialog offers "this month", but bills already generated are never
--   rewritten, and update_bill_amount() - which does exist - had no screen. So
--   raising a rate in the middle of a month after the month was billed left
--   that month's bill at the old amount while the client's "Monthly bill"
--   already showed the new one.
--
--   This wraps set_client_rate() and, when asked, update_bill_amount() in one
--   transaction, so the rate row and this month's bill change together or not
--   at all. update_bill_amount() keeps its own guards: a bill cannot drop
--   below what has already been collected against it, or below its adjustment.
--
-- PART 4 - collection_receipt()
--
--   One receipt for a whole collection, and correct figures on it. The receipt
--   page's own arithmetic ignored discounts and, for collectors, ignored every
--   payment another collector had taken on the same bill. See PART 4 below.
-- =============================================================================


-- =============================================================================
-- PART 1 - record_collection
-- =============================================================================
create or replace function public.record_collection(
  p_client_id      uuid,
  p_allocations    jsonb,
  p_payment_method public.payment_method default 'cash',
  p_notes          text default null,
  p_payment_date   date default null
)
returns setof public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid      uuid := public.require_active();
  v_date     date := coalesce(p_payment_date, public.dhaka_today());
  v_count    integer;
  v_distinct integer;
  v_alloc    record;
  v_bill     public.monthly_bills;
begin
  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'COLLECTION_EMPTY' using errcode = '22023';
  end if;

  -- Ten years of arrears. Anything longer is a malformed request.
  if jsonb_array_length(p_allocations) > 120 then
    raise exception 'COLLECTION_TOO_MANY' using errcode = '22023';
  end if;

  if v_date > public.dhaka_today() then
    raise exception 'FUTURE_PAYMENT_DATE' using errcode = '22023';
  end if;

  -- One allocation per bill. Two rows for the same month in one collection
  -- would also confuse the receipt's "previously paid", which orders payments
  -- on the same bill by created_at - and these would share it.
  select count(*),
         count(distinct date_trunc('month', (e ->> 'billing_month')::date))
    into v_count, v_distinct
    from jsonb_array_elements(p_allocations) e;

  if v_count <> v_distinct then
    raise exception 'COLLECTION_DUPLICATE_MONTH' using errcode = '22023';
  end if;

  -- Pass 1: lock every bill, oldest first, and check every allocation BEFORE
  -- writing anything. record_payment() would catch each problem too, but only
  -- after the earlier months had been written; checking up front lets the
  -- error name the month that is wrong. The locks are held to the end of the
  -- transaction, so nothing can change between this check and pass 2.
  for v_alloc in
    select date_trunc('month', (e ->> 'billing_month')::date)::date as billing_month,
           round((e ->> 'amount')::numeric, 2)                     as amount
      from jsonb_array_elements(p_allocations) e
     order by 1
  loop
    if v_alloc.amount is null or v_alloc.amount <= 0 then
      raise exception 'INVALID_AMOUNT' using errcode = '22023';
    end if;

    select * into v_bill
      from public.monthly_bills
     where client_id = p_client_id
       and billing_month = v_alloc.billing_month
     for update;

    if not found then
      raise exception 'COLLECTION_BILL_NOT_FOUND|%', to_char(v_alloc.billing_month, 'YYYY-MM-DD')
        using errcode = 'P0002';
    end if;

    if v_bill.due_amount <= 0 then
      raise exception 'COLLECTION_BILL_PAID|%', to_char(v_alloc.billing_month, 'YYYY-MM-DD')
        using errcode = '22023';
    end if;

    if v_alloc.amount > v_bill.due_amount then
      raise exception 'COLLECTION_EXCEEDS_DUE|%|%',
        to_char(v_alloc.billing_month, 'YYYY-MM-DD'),
        to_char(v_bill.due_amount, 'FM999999999.00')
        using errcode = '22023';
    end if;
  end loop;

  -- Pass 2: write them, through the same function a single payment uses.
  for v_alloc in
    select date_trunc('month', (e ->> 'billing_month')::date)::date as billing_month,
           round((e ->> 'amount')::numeric, 2)                     as amount
      from jsonb_array_elements(p_allocations) e
     order by 1
  loop
    return next public.record_payment(
      p_client_id, v_alloc.billing_month, v_alloc.amount,
      p_payment_method, p_notes, v_date
    );
  end loop;
end $fn$;

comment on function public.record_collection(uuid, jsonb, public.payment_method, text, date) is
  'Records one amount received across several of a client''s bills, as one '
  'payment row per bill, atomically. Each row goes through record_payment(). '
  'p_allocations: [{"billing_month":"YYYY-MM-01","amount":1000}, ...].';


-- =============================================================================
-- PART 2 - collection_bill_months
-- =============================================================================
create or replace function public.collection_bill_months(
  p_year    integer,
  p_area_id uuid default null
)
returns table (
  client_id    uuid,
  -- Twelve entries, January first. NULL where the client has no bill for
  -- that month - not zero, because "not billed" and "billed ৳0" differ.
  bill_amounts numeric[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Same access as collection_matrix(), the report this sits beside.
  perform public.require_admin();

  return query
  select c.id,
         array_agg(b.bill_amount order by gs.m)::numeric[]
    from public.clients c
   cross join generate_series(1, 12) as gs(m)
    left join public.monthly_bills b
           on b.client_id = c.id
          and b.billing_month = make_date(p_year, gs.m, 1)
   where (p_area_id is null or c.area_id = p_area_id)
     and exists (
           select 1
             from public.monthly_bills x
            where x.client_id = c.id
              and x.billing_month between make_date(p_year, 1, 1) and make_date(p_year, 12, 1)
         )
   group by c.id;
end $fn$;

comment on function public.collection_bill_months(integer, uuid) is
  'Per client, the bill_amount actually billed for each month of p_year '
  '(NULL where there is no bill). Shows rate changes as they reached the bills.';


-- =============================================================================
-- PART 3 - change_client_rate
-- =============================================================================
create or replace function public.change_client_rate(
  p_client_id           uuid,
  p_monthly_bill        numeric,
  p_effective_from      date,
  p_reason              text default null,
  p_update_current_bill boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month   date := date_trunc('month', coalesce(p_effective_from, public.dhaka_current_month()))::date;
  v_rate    public.client_rate_history;
  v_bill    public.monthly_bills;
  v_updated public.monthly_bills;
  v_did     boolean := false;
begin
  perform public.require_admin();

  -- Asking to rewrite this month's bill only makes sense for a change that
  -- takes effect this month. Refuse rather than quietly ignore the flag.
  if coalesce(p_update_current_bill, false) and v_month <> public.dhaka_current_month() then
    raise exception 'REBILL_ONLY_CURRENT_MONTH' using errcode = '22023';
  end if;

  -- All of set_client_rate()'s rules still apply, including that a rate can
  -- never take effect in a month before this one.
  v_rate := public.set_client_rate(p_client_id, p_monthly_bill, p_effective_from, p_reason);

  if coalesce(p_update_current_bill, false) then
    select * into v_bill
      from public.monthly_bills
     where client_id = p_client_id
       and billing_month = v_month;

    if found and v_bill.bill_amount <> v_rate.monthly_bill then
      -- Raises BILL_BELOW_PAID / BILL_BELOW_ADJUSTMENT when the new amount
      -- would not cover what is already on the bill - and because this is
      -- one transaction, the rate row above is rolled back with it.
      v_updated := public.update_bill_amount(v_bill.id, v_rate.monthly_bill);
      v_did := true;
    end if;
  end if;

  return jsonb_build_object(
    'rate', to_jsonb(v_rate),
    'bill', case when v_did then to_jsonb(v_updated) else null end
  );
end $fn$;

comment on function public.change_client_rate(uuid, numeric, date, text, boolean) is
  'set_client_rate(), optionally also re-billing the current month at the new '
  'rate, in one transaction.';


-- =============================================================================
-- PART 4 - collection_receipt
--
-- The receipt for a payment - or for every month of a collection - with each
-- line's figures as they stood when it was recorded.
--
-- It replaces arithmetic the receipt page did in the application, which was
-- wrong in two ways that both reached a printed receipt:
--
--   1. "Remaining due" was bill_amount - previously paid - this payment. That
--      ignores adjustments: a ৳1,000 bill with a ৳200 discount, paid ৳800 in
--      full, printed "Remaining due ৳200".
--
--   2. "Previously paid" was summed through the caller's RLS, and a collector
--      can only see payments they took themselves. So when Mama collected
--      ৳1,000 of a ৳1,500 bill and Jamal then collected the last ৳500, Jamal's
--      receipt printed "Previously paid ৳0, Remaining due ৳1,000" - for a bill
--      that was paid in full.
--
-- SECURITY DEFINER so the sum covers every payment on the bill, whoever took
-- it. That is exactly why it re-checks access first, mirroring the payments
-- RLS policy: an admin, or the collector who took this payment. The only
-- figures a collector gains are totals for a bill they are already allowed to
-- read in full (monthly_bills is readable by every active user, paid_amount
-- included) - never another collector's individual payments.
-- =============================================================================
create or replace function public.collection_receipt(p_payment_id uuid)
returns table (
  payment_id        uuid,
  receipt_no        bigint,
  billing_month     date,
  bill_amount       numeric,
  adjustment_amount numeric,
  adjusted_amount   numeric,
  previously_paid   numeric,
  amount            numeric,
  remaining_due     numeric,
  voided            boolean,
  void_reason       text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid    uuid := public.require_active();
  v_anchor public.payments;
  v_client uuid;
begin
  select * into v_anchor from public.payments where id = p_payment_id;

  -- Not found and not yours read the same, so the function cannot be used to
  -- probe which payment ids exist.
  if not found
     or (not public.is_admin() and v_anchor.collected_by is distinct from v_uid) then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select b.client_id into v_client
    from public.monthly_bills b
   where b.id = v_anchor.monthly_bill_id;

  -- The collection: same transaction timestamp, same collector, same client.
  -- A single payment is simply a collection of one.
  return query
  select p.id,
         p.receipt_no,
         b.billing_month,
         b.bill_amount,
         b.adjustment_amount,
         b.adjusted_amount,
         prior.paid,
         p.amount,
         greatest(b.adjusted_amount - prior.paid - p.amount, 0)::numeric,
         p.voided_at is not null,
         p.void_reason
    from public.payments p
    join public.monthly_bills b on b.id = p.monthly_bill_id
   cross join lateral (
         select coalesce(sum(q.amount), 0)::numeric as paid
           from public.payments q
          where q.monthly_bill_id = p.monthly_bill_id
            and q.voided_at is null
            and q.created_at < p.created_at
       ) prior
   where p.created_at   = v_anchor.created_at
     and p.collected_by = v_anchor.collected_by
     and b.client_id    = v_client
   order by b.billing_month;
end $fn$;

comment on function public.collection_receipt(uuid) is
  'Receipt lines for a payment and the rest of its collection. Previously paid '
  'counts every collector''s payments; remaining due uses the adjusted bill. '
  'Access mirrors payments RLS.';


-- =============================================================================
-- Privileges
-- =============================================================================
do $grants$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('record_collection', 'collection_bill_months', 'change_client_rate',
                         'collection_receipt')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
