-- =============================================================================
-- 0008_normalize_3nf.sql
-- Third Normal Form.
--
-- Two attributes in this schema were stored copies of facts that already lived
-- somewhere else. Both are transitive dependencies - a non-key column
-- determined by another non-key column - which is exactly what 3NF forbids,
-- and both were already capable of producing wrong numbers on screen.
--
-- ---------------------------------------------------------------------------
-- VIOLATION 1  clients.monthly_bill
--
--   client_rate_history holds the rate for every effective month. The rate in
--   force today is the newest row with effective_from <= this month, so
--   clients.monthly_bill was a second, independently-updated copy of a fact
--   that table already owned.
--
--   The anomaly was real, not theoretical. Schedule "1,500 from next month"
--   and clients.monthly_bill stayed at 1,000 - nothing moves it when the month
--   turns over. From the 1st onwards the client list and the client detail
--   page showed 1,000 while generate_monthly_bills() billed 1,500, and they
--   never reconciled until somebody happened to re-save the client form.
--
--   FIX: client_rate_history becomes the sole authority. Every client is
--   guaranteed an opening rate row at their start month, so the fallback that
--   used to reach for clients.monthly_bill is no longer needed, and the column
--   is dropped. The current rate is served to the API as a PostgREST computed
--   field of the same name, so callers still read `monthly_bill` - it is now
--   derived on read instead of stored twice.
--
-- ---------------------------------------------------------------------------
-- VIOLATION 2  payments.client_id
--
--   A payment belongs to a bill, and a bill belongs to a client:
--
--     payments.id -> payments.monthly_bill_id -> monthly_bills.client_id
--
--   monthly_bill_id is not a key of payments and client_id is not part of one,
--   so client_id was transitively dependent - the textbook 3NF violation. It
--   also had no constraint tying it to the bill's own client, so a direct
--   INSERT could file a payment under client A against client B's bill and
--   every report would then disagree with every other report depending on
--   which column it happened to join through.
--
--   FIX: the column is dropped. Payments reach their client through the bill,
--   which is the only path that can ever be right.
--
-- ---------------------------------------------------------------------------
-- NOT a violation, deliberately kept: monthly_bills.paid_amount
--
--   That column is an AGGREGATE over payments, not a functional dependency
--   between columns of monthly_bills, so 3NF has nothing to say about it. It
--   is a materialised sum, maintained only by sync_bill_paid_amount() and
--   re-derived by monthly_bills_derive_paid() if anything writes it directly,
--   and due_amount / status are generated from it. It is documented as a
--   deliberate materialisation rather than removed.
--
-- Safe to re-run. Safe on a database that already holds bills and payments.
-- =============================================================================


-- =============================================================================
-- PART 1 - clients.monthly_bill -> client_rate_history
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1a. Give every client an opening rate.
--
-- Runs only while clients.monthly_bill still exists, so re-running this file
-- after the column is gone is a no-op rather than an error.
--
-- Anchored at the start month, because that is the earliest month the client
-- can be billed for. Anything already in client_rate_history wins.
-- ----------------------------------------------------------------------------
do $backfill$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'clients'
       and column_name  = 'monthly_bill'
  ) then
    execute $sql$
      insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason)
      select c.id,
             c.monthly_bill,
             date_trunc('month', c.start_date)::date,
             'Opening rate'
        from public.clients c
       where not exists (
             select 1 from public.client_rate_history h
              where h.client_id = c.id
                and h.effective_from <= date_trunc('month', c.start_date)::date
           )
      on conflict (client_id, effective_from) do nothing
    $sql$;
  end if;
end $backfill$;

-- A client whose earliest rate row starts after their start_date would have no
-- rate for the months in between. Close that gap by back-dating a copy of the
-- earliest known rate to the start month.
insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason)
select c.id, first_rate.monthly_bill, date_trunc('month', c.start_date)::date, 'Opening rate'
  from public.clients c
  join lateral (
        select h.monthly_bill
          from public.client_rate_history h
         where h.client_id = c.id
         order by h.effective_from
         limit 1
       ) first_rate on true
 where not exists (
       select 1 from public.client_rate_history h
        where h.client_id = c.id
          and h.effective_from <= date_trunc('month', c.start_date)::date
     )
on conflict (client_id, effective_from) do nothing;

comment on table public.client_rate_history is
  'The authoritative rate for every client, by effective month. The rate in '
  'force for a month is the newest row with effective_from <= that month. '
  'Every client has an opening row at their start month.';

-- ----------------------------------------------------------------------------
-- 1b. The rate for a month, now sourced only from client_rate_history.
--
-- The third branch is defensive: it can only fire for a client whose rate rows
-- all start after the month being asked about, which 1a has just made
-- impossible. Returning the earliest known rate beats returning NULL and
-- writing a null bill_amount.
-- ----------------------------------------------------------------------------
create or replace function public.client_rate_for_month(
  p_client_id uuid,
  p_billing_month date
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (
      select h.monthly_bill
        from public.client_rate_history h
       where h.client_id = p_client_id
         and h.effective_from <= date_trunc('month', p_billing_month)::date
       order by h.effective_from desc
       limit 1
    ),
    (
      select h.monthly_bill
        from public.client_rate_history h
       where h.client_id = p_client_id
       order by h.effective_from
       limit 1
    ),
    0
  )
$fn$;

/** The rate in force this Dhaka month. */
create or replace function public.client_current_rate(p_client_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.client_rate_for_month(p_client_id, public.dhaka_current_month())
$fn$;

-- ----------------------------------------------------------------------------
-- 1c. PostgREST computed field.
--
-- A function taking one row of public.clients and named like a column is
-- exposed by PostgREST as a selectable column on that table:
--
--     .select("*, monthly_bill")
--
-- So `monthly_bill` still reads exactly the way it did when it was stored -
-- it is simply computed from client_rate_history now, which means it can no
-- longer disagree with the rate that bill generation uses.
--
-- Not returned by "*" on its own: computed fields must be named explicitly.
-- ----------------------------------------------------------------------------
create or replace function public.monthly_bill(c public.clients)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.client_rate_for_month(c.id, public.dhaka_current_month())
$fn$;

comment on function public.monthly_bill(public.clients) is
  'PostgREST computed field: the client''s rate for the current month, derived '
  'from client_rate_history. Replaces the former clients.monthly_bill column.';

-- ----------------------------------------------------------------------------
-- 1d. Scheduling a rate change no longer writes a second copy.
-- ----------------------------------------------------------------------------
create or replace function public.set_client_rate(
  p_client_id uuid,
  p_monthly_bill numeric,
  p_effective_from date,
  p_reason text default null
)
returns public.client_rate_history
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid    uuid := public.require_admin();
  v_amount numeric(12,2) := round(coalesce(p_monthly_bill, 0), 2);
  v_month  date := date_trunc('month', coalesce(p_effective_from, public.dhaka_current_month()))::date;
  v_row    public.client_rate_history;
begin
  if v_amount < 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Section 27: never let a rate change reach a month that is already billed.
  if v_month < public.dhaka_current_month() then
    raise exception 'RATE_EFFECTIVE_IN_PAST' using errcode = '22023';
  end if;

  insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason, changed_by)
  values (p_client_id, v_amount, v_month, nullif(btrim(p_reason), ''), v_uid)
  on conflict (client_id, effective_from) do update
    set monthly_bill = excluded.monthly_bill,
        reason       = excluded.reason,
        changed_by   = excluded.changed_by,
        created_at   = now()
  returning * into v_row;

  -- No second copy to keep in step: clients.monthly_bill is gone, and the
  -- computed field reads this row.

  perform public.write_audit('client.rate_changed', 'client', p_client_id, null, to_jsonb(v_row));
  return v_row;
end $fn$;

-- ----------------------------------------------------------------------------
-- 1e. upsert_client writes the rate to client_rate_history only.
--
-- The signature is unchanged, so callers keep passing p_monthly_bill and keep
-- meaning "the rate from now on". Where it lands is the only difference:
--
--   INSERT - an opening rate row at the client's start month.
--   UPDATE - a rate row effective this month, but only when the value actually
--            changed. Months already billed keep their own snapshot in
--            monthly_bills.bill_amount, so history never moves.
--
-- Dropped first because 0005 left a 10-argument version behind; re-running
-- must not leave two overloads for PostgREST to choose between.
-- ----------------------------------------------------------------------------
drop function if exists public.upsert_client(uuid, text, text, text, text, numeric, date, public.client_status, text);
drop function if exists public.upsert_client(uuid, text, text, text, text, numeric, date, public.client_status, text, uuid);

create function public.upsert_client(
  p_id uuid,
  p_client_code text,
  p_name text,
  p_phone text,
  p_address text,
  p_monthly_bill numeric,
  p_start_date date,
  p_status public.client_status,
  p_notes text,
  p_area_id uuid default null
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old      public.clients;
  v_new      public.clients;
  v_amount   numeric(12,2) := round(coalesce(p_monthly_bill, 0), 2);
  v_start    date;
  v_current  numeric(12,2);
begin
  perform public.require_admin();

  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'NAME_REQUIRED' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_client_code, ''))) = 0 then
    raise exception 'CLIENT_CODE_REQUIRED' using errcode = '22023';
  end if;
  if v_amount < 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;
  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id) then
    raise exception 'AREA_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_id is null then
    insert into public.clients (client_code, name, phone, address, start_date, status, notes, area_id)
    values (
      upper(btrim(p_client_code)), btrim(p_name), nullif(btrim(p_phone), ''),
      nullif(btrim(p_address), ''),
      coalesce(p_start_date, public.dhaka_today()),
      coalesce(p_status, 'active'), nullif(btrim(p_notes), ''), p_area_id
    )
    returning * into v_new;

    -- Every client starts life with exactly one rate row, which is what lets
    -- client_rate_for_month() stop falling back to a stored column.
    insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason, changed_by)
    values (v_new.id, v_amount, date_trunc('month', v_new.start_date)::date, 'Opening rate', auth.uid())
    on conflict (client_id, effective_from) do update
      set monthly_bill = excluded.monthly_bill,
          changed_by   = excluded.changed_by;

    perform public.write_audit('client.created', 'client', v_new.id, null, to_jsonb(v_new));
  else
    select * into v_old from public.clients where id = p_id for update;
    if not found then
      raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
    end if;

    v_current := public.client_current_rate(p_id);

    update public.clients
       set client_code  = upper(btrim(p_client_code)),
           name         = btrim(p_name),
           phone        = nullif(btrim(p_phone), ''),
           address      = nullif(btrim(p_address), ''),
           start_date   = coalesce(p_start_date, v_old.start_date),
           status       = coalesce(p_status, v_old.status),
           notes        = nullif(btrim(p_notes), ''),
           area_id      = p_area_id
     where id = p_id
    returning * into v_new;

    -- A rate change made here takes effect from the current month onwards.
    if v_current is distinct from v_amount then
      insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason, changed_by)
      values (p_id, v_amount, public.dhaka_current_month(), 'Updated from client form', auth.uid())
      on conflict (client_id, effective_from) do update
        set monthly_bill = excluded.monthly_bill,
            changed_by   = excluded.changed_by,
            created_at   = now();
    end if;

    -- start_date may have moved earlier than the first rate row. Re-anchor so
    -- the client still has a rate for every month they can be billed for.
    v_start := date_trunc('month', v_new.start_date)::date;
    insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason, changed_by)
    select p_id, h.monthly_bill, v_start, 'Opening rate', auth.uid()
      from public.client_rate_history h
     where h.client_id = p_id
       and not exists (
             select 1 from public.client_rate_history e
              where e.client_id = p_id and e.effective_from <= v_start
           )
     order by h.effective_from
     limit 1
    on conflict (client_id, effective_from) do nothing;

    perform public.write_audit('client.updated', 'client', p_id, to_jsonb(v_old), to_jsonb(v_new));
  end if;

  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- 1f. The client overview now reports the rate for the month being viewed,
--     which is strictly more correct than the single "current" figure the
--     dropped column could hold.
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
         rate.monthly_bill,
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
    -- One indexed lookup per row against client_rate_history (client_id,
    -- effective_from desc), rather than a stored copy that could be stale.
    left join lateral (
          select h.monthly_bill
            from public.client_rate_history h
           where h.client_id = c.id
             and h.effective_from <= v_month
           order by h.effective_from desc
           limit 1
         ) rate on true
   where (p_status is null or c.status = p_status)
     and (p_area_id is null or c.area_id = p_area_id)
     and (v_search is null or c.search_text ilike '%' || v_search || '%')
   order by c.name
   limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $fn$;

-- ----------------------------------------------------------------------------
-- 1g. The column has no readers left. Drop it.
-- ----------------------------------------------------------------------------
alter table public.clients drop column if exists monthly_bill;


-- =============================================================================
-- PART 2 - payments.client_id
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 2a. Refuse to drop the column while it disagrees with the bills.
--
-- On a healthy database this finds nothing. If it finds something, the copy
-- and the bill have already diverged and somebody has to decide which is
-- right - silently dropping the column would bury the evidence.
-- ----------------------------------------------------------------------------
do $guard$
declare
  v_bad bigint;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'payments'
       and column_name  = 'client_id'
  ) then
    execute $sql$
      select count(*)
        from public.payments p
        join public.monthly_bills b on b.id = p.monthly_bill_id
       where b.client_id is distinct from p.client_id
    $sql$ into v_bad;

    if v_bad > 0 then
      raise exception
        'PAYMENTS_CLIENT_MISMATCH: % payment(s) name a different client than their bill does. Reconcile before migrating.',
        v_bad
        using errcode = '23514';
    end if;
  end if;
end $guard$;

-- ----------------------------------------------------------------------------
-- 2b. Replace everything that reads payments.client_id.
--
-- Every one of these now reaches the client through monthly_bills, which is
-- the only path that cannot disagree with itself.
-- ----------------------------------------------------------------------------

-- The immutability guard no longer has a client_id to protect. The bill
-- reference still cannot move, and monthly_bills_derive_paid() already refuses
-- to let a bill change client, so a payment's client is pinned twice over.
create or replace function public.payments_immutability_guard()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'PAYMENT_DELETE_FORBIDDEN'
      using hint = 'Void the payment instead of deleting it.', errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.receipt_no is distinct from old.receipt_no
     or new.monthly_bill_id is distinct from old.monthly_bill_id
     or new.amount is distinct from old.amount
     or new.payment_date is distinct from old.payment_date
     or new.payment_method is distinct from old.payment_method
     or new.collected_by is distinct from old.collected_by
     or new.created_at is distinct from old.created_at then
    raise exception 'PAYMENT_IMMUTABLE'
      using hint = 'Only void fields and notes may change on a payment.', errcode = '42501';
  end if;

  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'PAYMENT_ALREADY_VOIDED'
      using hint = 'A voided payment cannot be un-voided.', errcode = '42501';
  end if;

  return new;
end $fn$;

-- record_payment: the bill it locks already carries the client.
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
  -- so a waived bill correctly reports nothing left to collect (0004).
  v_due := v_bill.due_amount;

  if v_due <= 0 then
    raise exception 'BILL_ALREADY_PAID' using errcode = '22023';
  end if;

  -- MVP rule: no overpayment / advance.
  if v_amount > v_due then
    raise exception 'PAYMENT_EXCEEDS_DUE|%', to_char(v_due, 'FM999999999.00')
      using errcode = '22023';
  end if;

  insert into public.payments (
    monthly_bill_id, amount, payment_date,
    payment_method, collected_by, notes
  )
  values (
    v_bill.id, v_amount, v_date,
    coalesce(p_payment_method, 'cash'), v_uid, nullif(btrim(p_notes), '')
  )
  returning * into v_payment;

  perform public.write_audit(
    'payment.created', 'payment', v_payment.id, null, to_jsonb(v_payment)
  );

  return v_payment;
end $fn$;

-- delete_client: "has this client ever been paid" is now a question about
-- their bills.
create or replace function public.delete_client(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.clients;
begin
  perform public.require_admin();

  select * into v_old from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.payments p
      join public.monthly_bills b on b.id = p.monthly_bill_id
     where b.client_id = p_client_id
  ) then
    raise exception 'CLIENT_HAS_PAYMENTS' using errcode = '42501';
  end if;

  delete from public.monthly_bills where client_id = p_client_id;
  -- The rate rows are the client's own; ON DELETE CASCADE clears them.
  delete from public.clients where id = p_client_id;

  perform public.write_audit('client.deleted', 'client', p_client_id, to_jsonb(v_old), null);
end $fn$;

-- dashboard_summary: the area filter on cash flow joins through the bill.
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
  v_end   date := (date_trunc('month', v_month) + interval '1 month - 1 day')::date;
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
  join public.monthly_bills pb on pb.id = p.monthly_bill_id
  join public.clients c on c.id = pb.client_id
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
    'total_outstanding', (
      select coalesce(sum(b.due_amount), 0)
        from public.monthly_bills b
        join public.clients c on c.id = b.client_id
       where b.due_amount > 0
         and (p_area_id is null or c.area_id = p_area_id)
    ),
    'unsubmitted_cash', v_cash
  ) || v_bills || v_flow;
end $fn$;

-- collector_series: same, for the per-collector area filter.
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
           select 1
             from public.monthly_bills b
             join public.clients c on c.id = b.client_id
            where b.id = p.monthly_bill_id
              and c.area_id = p_area_id))
   group by pr.id, pr.full_name
  having count(p.id) > 0
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

-- daily_collection_report: same join, one level deeper.
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
    join public.monthly_bills b on b.id = p.monthly_bill_id
    join public.clients c on c.id = b.client_id
   where p.voided_at is null
     and p.payment_date = v_date
     and (p_area_id is null or c.area_id = p_area_id)
   group by pr.id, pr.full_name
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

-- collection_matrix: the payment side becomes a LATERAL so the "clients who
-- paid nothing still get a row" behaviour is preserved exactly.
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
    -- LATERAL, not a WHERE: every payment predicate has to stay on the inside
    -- or the join silently turns inner and drops the clients who paid nothing.
    left join lateral (
          select p2.id, p2.amount, p2.payment_date
            from public.payments p2
            join public.monthly_bills b2 on b2.id = p2.monthly_bill_id
           where b2.client_id = c.id
             and p2.voided_at is null
             and p2.payment_date between v_from and v_to
             and (p_collector_id is null or p2.collected_by = p_collector_id)
         ) p on true
   where (p_area_id is null or c.area_id = p_area_id)
   group by c.id, c.client_code, c.name, c.area_id, a.name
   order by c.name;
end $fn$;

-- collection_summary: "paying clients" is now counted off the bill.
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
    'paying_clients',    count(distinct pb.client_id),
    'average_payment',   case when count(p.id) > 0
                              then round(coalesce(sum(p.amount), 0) / count(p.id), 2)
                              else 0 end
  )
  into v_flow
  from public.payments p
  join public.monthly_bills pb on pb.id = p.monthly_bill_id
  join public.clients c on c.id = pb.client_id
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

-- client_payment_history: the bill was already joined, so the filter simply
-- moves onto it.
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
   where b.client_id = p_client_id
     and (p_year is null or extract(year from p.payment_date)::integer = p_year)
     -- RLS is bypassed inside a SECURITY DEFINER function, so the collector
     -- restriction that payments_select would apply is re-stated here.
     and (public.is_admin() or p.collected_by = auth.uid())
   order by p.payment_date desc, p.created_at desc
   limit greatest(1, least(coalesce(p_limit, 500), 2000));
end $fn$;

-- client_financial_summary: same move.
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
    join public.monthly_bills b on b.id = p.monthly_bill_id
   where b.client_id = p_client_id
     and p.voided_at is null
     and (p_year is null or extract(year from p.payment_date)::integer = p_year)
     and (public.is_admin() or p.collected_by = auth.uid());

  return jsonb_build_object('year', p_year, 'paid_in_period', v_paid) || v_bills;
end $fn$;

-- ----------------------------------------------------------------------------
-- 2c. Drop the column and re-cut the index that depended on it.
--
-- payments_client_idx served "this client's payments, newest first". That
-- query now starts from the client's bills, so the equivalent index is on
-- the bill reference.
-- ----------------------------------------------------------------------------
drop index if exists public.payments_client_idx;

alter table public.payments drop column if exists client_id;

create index if not exists payments_bill_date_idx
  on public.payments (monthly_bill_id, payment_date desc);

comment on column public.payments.monthly_bill_id is
  'The bill this payment settles. The client is reached through it - payments '
  'deliberately does NOT carry its own client_id (3NF: it would be '
  'transitively dependent on this column).';

comment on column public.monthly_bills.paid_amount is
  'Materialised sum of non-voided payments against this bill. Maintained only '
  'by sync_bill_paid_amount(); re-derived by monthly_bills_derive_paid() if '
  'anything writes it directly. An aggregate, not a stored duplicate of a '
  'column - due_amount and status are generated from it.';


-- =============================================================================
-- PART 3 - privileges for everything created or replaced above
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
       and p.proname in (
         'client_rate_for_month', 'client_current_rate', 'monthly_bill',
         'set_client_rate', 'upsert_client', 'client_month_overview',
         'record_payment', 'delete_client', 'dashboard_summary',
         'collector_series', 'daily_collection_report',
         'collection_matrix', 'collection_summary',
         'client_payment_history', 'client_financial_summary'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;

-- The anon role never needs table access; auth happens before anything else.
revoke all on all tables in schema public from anon;
