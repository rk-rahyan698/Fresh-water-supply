-- =============================================================================
-- setup.sql  -  complete database setup in ONE file
--
-- GENERATED FILE - do not edit by hand.
-- Run `npm run build:setup` after changing anything in supabase/migrations/.
--
-- Every migration in supabase/migrations/ concatenated in order. Paste the
-- whole thing into a new query in the Supabase SQL Editor and Run.
--
-- It lives OUTSIDE supabase/migrations/ on purpose, so `supabase db push`
-- does not apply the same SQL twice. If you use the Supabase CLI, ignore this
-- file and push the migrations folder instead.
--
-- Safe to re-run on a database that already holds data.
-- =============================================================================

-- >>>>>>>>>>>>>>>>>>>>>>>>  0001_init_schema.sql  <<<<<<<<<<<<<<<<<<<<<<<<

-- =============================================================================
-- 0001_init_schema.sql
-- Water Supply Business - core schema
--
-- Design principles (see README "Financial integrity"):
--   * monthly_bills.paid_amount is a CACHE maintained ONLY by a trigger that
--     re-sums non-voided payments. Application code never writes it.
--   * due_amount and status are GENERATED columns, so the rules in the spec
--     cannot drift from the data.
--   * payments are immutable: updates are restricted to the void fields and
--     deletes are rejected outright.
-- =============================================================================

-- gen_random_uuid() is core Postgres since 13, so only pg_trgm is needed.
-- It powers the trigram index behind client search.
create extension if not exists pg_trgm;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('admin', 'collector');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.client_status as enum ('active', 'inactive');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.bill_status as enum ('unpaid', 'partial', 'paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('cash', 'bank', 'mobile_banking', 'other');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Time helpers - the business runs on Asia/Dhaka calendar days
-- ----------------------------------------------------------------------------
create or replace function public.dhaka_today()
returns date
language sql
stable
as $fn$ select (now() at time zone 'Asia/Dhaka')::date $fn$;

create or replace function public.dhaka_current_month()
returns date
language sql
stable
as $fn$ select date_trunc('month', (now() at time zone 'Asia/Dhaka'))::date $fn$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

-- ----------------------------------------------------------------------------
-- profiles - one row per auth user
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) > 0),
  phone       text,
  email       text,
  role        public.user_role not null default 'collector',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role) where is_active;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Mirror new auth users into profiles. SECURITY DEFINER so it can write
-- regardless of the RLS policies added in 0003.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.profiles (id, full_name, phone, email, role)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(coalesce(new.email, 'user'), '@', 1)
    ),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', new.phone)), ''),
    new.email,
    case when (new.raw_user_meta_data ->> 'role') = 'admin'
         then 'admin'::public.user_role
         else 'collector'::public.user_role end
  )
  on conflict (id) do nothing;
  return new;
end $fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ----------------------------------------------------------------------------
-- clients
-- ----------------------------------------------------------------------------
create table if not exists public.clients (
  id            uuid primary key default gen_random_uuid(),
  client_code   text not null unique check (length(btrim(client_code)) > 0),
  name          text not null check (length(btrim(name)) > 0),
  phone         text,
  address       text,
  monthly_bill  numeric(12,2) not null default 0 check (monthly_bill >= 0),
  start_date    date not null default public.dhaka_today(),
  status        public.client_status not null default 'active',
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Single searchable column so mobile search stays one fast indexed query.
  search_text   text generated always as (
                  coalesce(name, '') || ' ' ||
                  coalesce(client_code, '') || ' ' ||
                  coalesce(phone, '') || ' ' ||
                  coalesce(address, '')
                ) stored
);

create index if not exists clients_status_idx on public.clients (status);
create index if not exists clients_name_idx on public.clients (name);
create index if not exists clients_search_trgm_idx
  on public.clients using gin (search_text gin_trgm_ops);

drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- monthly_bills
-- ----------------------------------------------------------------------------
create table if not exists public.monthly_bills (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete restrict,
  -- Always the 1st of the month, so "August 2026" has exactly one representation.
  billing_month date not null check (billing_month = date_trunc('month', billing_month)::date),
  bill_amount   numeric(12,2) not null check (bill_amount >= 0),
  -- Cache of sum(payments.amount) where not voided. Written only by trigger.
  paid_amount   numeric(12,2) not null default 0 check (paid_amount >= 0),
  due_amount    numeric(12,2) generated always as (bill_amount - paid_amount) stored,
  status        public.bill_status generated always as (
                  case
                    when bill_amount <= 0 then 'paid'::public.bill_status
                    when paid_amount <= 0 then 'unpaid'::public.bill_status
                    when paid_amount >= bill_amount then 'paid'::public.bill_status
                    else 'partial'::public.bill_status
                  end
                ) stored,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A client can never accidentally get two bills for the same month.
  constraint monthly_bills_client_month_key unique (client_id, billing_month),
  -- Due can never go negative.
  constraint monthly_bills_no_overpayment check (paid_amount <= bill_amount)
);

create index if not exists monthly_bills_month_idx on public.monthly_bills (billing_month desc);
create index if not exists monthly_bills_client_idx on public.monthly_bills (client_id, billing_month desc);
create index if not exists monthly_bills_due_idx on public.monthly_bills (billing_month, due_amount)
  where due_amount > 0;

drop trigger if exists monthly_bills_set_updated_at on public.monthly_bills;
create trigger monthly_bills_set_updated_at
  before update on public.monthly_bills
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- payments - immutable financial transactions
-- ----------------------------------------------------------------------------
create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  -- Short human-readable transaction id printed on receipts.
  receipt_no      bigint generated always as identity unique,
  client_id       uuid not null references public.clients(id) on delete restrict,
  monthly_bill_id uuid not null references public.monthly_bills(id) on delete restrict,
  amount          numeric(12,2) not null check (amount > 0),
  payment_date    date not null default public.dhaka_today(),
  payment_method  public.payment_method not null default 'cash',
  collected_by    uuid not null references public.profiles(id) on delete restrict,
  notes           text,
  voided_at       timestamptz,
  voided_by       uuid references public.profiles(id) on delete restrict,
  void_reason     text,
  created_at      timestamptz not null default now(),
  constraint payments_void_fields_consistent check (
    (voided_at is null and voided_by is null and void_reason is null)
    or (voided_at is not null and voided_by is not null)
  )
);

create index if not exists payments_bill_idx on public.payments (monthly_bill_id);

-- payments.client_id is removed by 0008 (it was transitively dependent on
-- monthly_bill_id - see that file). Guarded rather than deleted outright so
-- this file still describes the schema it originally created, and so that
-- re-running the whole migration set on an already-migrated database does not
-- fail here trying to index a column that is no longer there.
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'payments' and column_name = 'client_id'
  ) then
    execute 'create index if not exists payments_client_idx
               on public.payments (client_id, payment_date desc)';
  end if;
end $$;
create index if not exists payments_collector_date_idx on public.payments (collected_by, payment_date desc);
create index if not exists payments_date_idx on public.payments (payment_date desc);
create index if not exists payments_active_idx on public.payments (payment_date) where voided_at is null;

-- Recompute the owning bill's paid_amount from the payment rows themselves.
create or replace function public.sync_bill_paid_amount()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_bill_ids uuid[];
  v_bill_id  uuid;
begin
  v_bill_ids := array_remove(array[
    case when tg_op in ('INSERT', 'UPDATE') then new.monthly_bill_id end,
    case when tg_op in ('DELETE', 'UPDATE') then old.monthly_bill_id end
  ], null);

  foreach v_bill_id in array v_bill_ids loop
    update public.monthly_bills b
       set paid_amount = coalesce((
             select sum(p.amount)
               from public.payments p
              where p.monthly_bill_id = b.id
                and p.voided_at is null
           ), 0),
           updated_at = now()
     where b.id = v_bill_id;
  end loop;

  return null;
end $fn$;

drop trigger if exists payments_sync_bill on public.payments;
create trigger payments_sync_bill
  after insert or update or delete on public.payments
  for each row execute function public.sync_bill_paid_amount();

-- Immutability guard: money rows are never rewritten or removed.
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
     or new.client_id is distinct from old.client_id
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

drop trigger if exists payments_guard on public.payments;
create trigger payments_guard
  before update or delete on public.payments
  for each row execute function public.payments_immutability_guard();

-- Makes monthly_bills.paid_amount tamper-proof.
--
-- Admins hold an RLS write policy on monthly_bills (they need it to correct a
-- bill amount), which would otherwise let a raw REST call set paid_amount by
-- hand and desync it from the payment rows. Rather than reject such a write,
-- this silently re-derives the value from the source of truth - so the column
-- is self-correcting no matter who writes it, including the sync trigger above.
create or replace function public.monthly_bills_derive_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- The identity of a bill is fixed once created.
  if new.client_id is distinct from old.client_id
     or new.billing_month is distinct from old.billing_month then
    raise exception 'BILL_IMMUTABLE_KEY'
      using hint = 'A bill cannot be moved to another client or month.', errcode = '42501';
  end if;

  if new.paid_amount is distinct from old.paid_amount then
    new.paid_amount := coalesce((
      select sum(p.amount)
        from public.payments p
       where p.monthly_bill_id = new.id
         and p.voided_at is null
    ), 0);
  end if;

  return new;
end $fn$;

drop trigger if exists monthly_bills_guard on public.monthly_bills;
create trigger monthly_bills_guard
  before update on public.monthly_bills
  for each row execute function public.monthly_bills_derive_paid();

-- ----------------------------------------------------------------------------
-- cash_submissions - collector hands cash to the owner
-- ----------------------------------------------------------------------------
create table if not exists public.cash_submissions (
  id              uuid primary key default gen_random_uuid(),
  collector_id    uuid not null references public.profiles(id) on delete restrict,
  submission_date date not null default public.dhaka_today(),
  amount          numeric(12,2) not null check (amount > 0),
  received_by     uuid not null references public.profiles(id) on delete restrict,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists cash_submissions_collector_idx
  on public.cash_submissions (collector_id, submission_date desc);
create index if not exists cash_submissions_date_idx
  on public.cash_submissions (submission_date desc);

-- ----------------------------------------------------------------------------
-- audit_logs
-- ----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);


-- >>>>>>>>>>>>>>>>>>>>>>>>  0002_functions.sql  <<<<<<<<<<<<<<<<<<<<<<<<

-- =============================================================================
-- 0002_functions.sql
-- All money-moving operations live here as SECURITY DEFINER functions.
--
-- Why: they run atomically, take row locks (so a double-tapped "Collect"
-- button cannot overpay a bill), re-check authorisation server-side, and write
-- the audit log in the same transaction as the change.
--
-- Errors are raised as stable UPPERCASE tokens, optionally with "|detail".
-- src/lib/errors.ts maps them to friendly messages.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Authorisation helpers
-- ----------------------------------------------------------------------------

-- SECURITY DEFINER so RLS policies on profiles can call it without recursing.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select role from public.profiles where id = auth.uid() and is_active
$fn$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'admin' and is_active
  )
$fn$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from public.profiles where id = auth.uid() and is_active)
$fn$;

create or replace function public.require_active()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles where id = v_uid and is_active) then
    raise exception 'USER_INACTIVE' using errcode = '42501';
  end if;
  return v_uid;
end $fn$;

create or replace function public.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.require_active();
begin
  if not public.is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = '42501';
  end if;
  return v_uid;
end $fn$;

create or replace function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_old jsonb,
  p_new jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  insert into public.audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_old, p_new);
$fn$;

-- ----------------------------------------------------------------------------
-- record_payment - the single entry point for collecting money
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

  -- A payment can never be dated in the future (Dhaka calendar).
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

  v_due := v_bill.bill_amount - v_bill.paid_amount;

  if v_due <= 0 then
    raise exception 'BILL_ALREADY_PAID' using errcode = '22023';
  end if;

  -- MVP rule: no overpayment / advance.
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
-- void_payment - the safe alternative to deleting a transaction
-- ----------------------------------------------------------------------------
create or replace function public.void_payment(
  p_payment_id uuid,
  p_reason text
)
returns public.payments
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.require_admin();
  v_old public.payments;
  v_new public.payments;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'VOID_REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into v_old from public.payments where id = p_payment_id for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_old.voided_at is not null then
    raise exception 'PAYMENT_ALREADY_VOIDED' using errcode = '22023';
  end if;

  update public.payments
     set voided_at   = now(),
         voided_by   = v_uid,
         void_reason = btrim(p_reason)
   where id = p_payment_id
  returning * into v_new;

  perform public.write_audit(
    'payment.voided', 'payment', p_payment_id, to_jsonb(v_old), to_jsonb(v_new)
  );

  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- Bill generation
-- ----------------------------------------------------------------------------
create or replace function public.generate_monthly_bills(p_billing_month date)
returns table (created_count integer, skipped_count integer, billed_amount numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month     date := date_trunc('month', p_billing_month)::date;
  v_month_end date := (date_trunc('month', p_billing_month) + interval '1 month - 1 day')::date;
  v_eligible  integer := 0;
  v_created   integer := 0;
  v_billed    numeric(12,2) := 0;
begin
  perform public.require_admin();

  if v_month > public.dhaka_current_month() then
    raise exception 'FUTURE_BILLING_MONTH' using errcode = '22023';
  end if;

  -- Clients who had started service on or before the end of that month.
  select count(*) into v_eligible
    from public.clients
   where status = 'active'
     and start_date <= v_month_end;

  with inserted as (
    insert into public.monthly_bills (client_id, billing_month, bill_amount)
    select c.id, v_month, c.monthly_bill
      from public.clients c
     where c.status = 'active'
       and c.start_date <= v_month_end
    on conflict (client_id, billing_month) do nothing
    returning bill_amount
  )
  select count(*)::integer, coalesce(sum(bill_amount), 0)
    into v_created, v_billed
    from inserted;

  perform public.write_audit(
    'bills.generated', 'monthly_bill', null, null,
    jsonb_build_object(
      'billing_month', v_month,
      'created', v_created,
      'skipped', v_eligible - v_created,
      'billed_amount', v_billed
    )
  );

  created_count := v_created;
  skipped_count := v_eligible - v_created;
  billed_amount := v_billed;
  return next;
end $fn$;

-- Create/repair a single client's bill for a month (used from the client page).
create or replace function public.generate_client_bill(
  p_client_id uuid,
  p_billing_month date
)
returns public.monthly_bills
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month  date := date_trunc('month', p_billing_month)::date;
  v_client public.clients;
  v_bill   public.monthly_bills;
begin
  perform public.require_admin();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_client.status <> 'active' then
    raise exception 'CLIENT_INACTIVE' using errcode = '22023';
  end if;
  if v_month > public.dhaka_current_month() then
    raise exception 'FUTURE_BILLING_MONTH' using errcode = '22023';
  end if;

  select * into v_bill
    from public.monthly_bills
   where client_id = p_client_id and billing_month = v_month;

  if found then
    raise exception 'BILL_ALREADY_EXISTS' using errcode = '23505';
  end if;

  insert into public.monthly_bills (client_id, billing_month, bill_amount)
  values (p_client_id, v_month, v_client.monthly_bill)
  returning * into v_bill;

  perform public.write_audit(
    'bill.created', 'monthly_bill', v_bill.id, null, to_jsonb(v_bill)
  );

  return v_bill;
end $fn$;

-- Adjust a bill amount (e.g. wrong rate billed). Never touches paid_amount.
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

  -- Would push due negative, i.e. more already collected than the new bill.
  if v_amount < v_old.paid_amount then
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
-- Cash submission
-- ----------------------------------------------------------------------------
create or replace function public.create_cash_submission(
  p_collector_id uuid,
  p_amount numeric,
  p_submission_date date default null,
  p_notes text default null
)
returns public.cash_submissions
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid         uuid := public.require_admin();
  v_amount      numeric(12,2) := round(coalesce(p_amount, 0), 2);
  v_date        date := coalesce(p_submission_date, public.dhaka_today());
  v_collected   numeric(12,2);
  v_submitted   numeric(12,2);
  v_unsubmitted numeric(12,2);
  v_row         public.cash_submissions;
begin
  if v_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = '22023';
  end if;

  if v_date > public.dhaka_today() then
    raise exception 'FUTURE_SUBMISSION_DATE' using errcode = '22023';
  end if;

  -- Lock the collector row so two admins cannot both accept the same cash.
  perform 1 from public.profiles where id = p_collector_id for update;
  if not found then
    raise exception 'COLLECTOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(sum(amount), 0) into v_collected
    from public.payments
   where collected_by = p_collector_id
     and voided_at is null
     and payment_method = 'cash';

  select coalesce(sum(amount), 0) into v_submitted
    from public.cash_submissions
   where collector_id = p_collector_id;

  v_unsubmitted := v_collected - v_submitted;

  if v_amount > v_unsubmitted then
    raise exception 'SUBMISSION_EXCEEDS_COLLECTED|%', to_char(v_unsubmitted, 'FM999999999.00')
      using errcode = '22023';
  end if;

  insert into public.cash_submissions (collector_id, submission_date, amount, received_by, notes)
  values (p_collector_id, v_date, v_amount, v_uid, nullif(btrim(p_notes), ''))
  returning * into v_row;

  perform public.write_audit(
    'cash_submission.created', 'cash_submission', v_row.id, null, to_jsonb(v_row)
  );

  return v_row;
end $fn$;

-- ----------------------------------------------------------------------------
-- Collector figures
--
-- Cash reconciliation only counts payment_method = 'cash': bank and mobile
-- banking transfers never pass through the collector's hands.
-- ----------------------------------------------------------------------------
create or replace function public.collector_stats(
  p_collector_id uuid,
  p_month date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := public.require_active();
  v_month date := date_trunc('month', coalesce(p_month, public.dhaka_today()))::date;
  v_end   date := (date_trunc('month', coalesce(p_month, public.dhaka_today())) + interval '1 month - 1 day')::date;
  v_today date := public.dhaka_today();
  v_result jsonb;
begin
  if p_collector_id <> v_uid and not public.is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'collector_id', p_collector_id,
    'today_collection', coalesce(sum(amount) filter (where payment_date = v_today), 0),
    'today_count',      coalesce(count(*)   filter (where payment_date = v_today), 0),
    'month_collection', coalesce(sum(amount) filter (where payment_date between v_month and v_end), 0),
    'month_count',      coalesce(count(*)   filter (where payment_date between v_month and v_end), 0),
    'total_collection', coalesce(sum(amount), 0),
    'total_count',      coalesce(count(*), 0),
    'cash_collection',  coalesce(sum(amount) filter (where payment_method = 'cash'), 0)
  )
  into v_result
  from public.payments
  where collected_by = p_collector_id
    and voided_at is null;

  select v_result
      || jsonb_build_object('total_submitted', coalesce(sum(amount), 0))
      || jsonb_build_object(
           'unsubmitted',
           (v_result ->> 'cash_collection')::numeric - coalesce(sum(amount), 0)
         )
    into v_result
    from public.cash_submissions
   where collector_id = p_collector_id;

  return v_result;
end $fn$;

-- ----------------------------------------------------------------------------
-- Dashboard + reports
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

  -- Bill-month basis: billed / collected-against / still due for that month.
  select jsonb_build_object(
    'billed_amount',    coalesce(sum(bill_amount), 0),
    'collected_amount', coalesce(sum(paid_amount), 0),
    'due_amount',       coalesce(sum(due_amount), 0),
    'bill_count',       count(*),
    'unpaid_count',     count(*) filter (where status = 'unpaid'),
    'partial_count',    count(*) filter (where status = 'partial'),
    'paid_count',       count(*) filter (where status = 'paid')
  )
  into v_bills
  from public.monthly_bills
  where billing_month = v_month;

  -- Payment-date basis: cash actually received in the window.
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

-- Billed / collected / due for the last N months - dashboard bar chart.
--
-- Dropped first rather than CREATE OR REPLACE: a later migration widens this
-- RETURNS TABLE signature, and Postgres refuses to change a return type in
-- place. Without the drop, re-running this file after 0004 would fail.
drop function if exists public.monthly_series(integer);

create function public.monthly_series(p_months integer default 6)
returns table (
  billing_month date,
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
         coalesce(sum(b.paid_amount), 0)::numeric,
         coalesce(sum(b.due_amount), 0)::numeric
    from months m
    left join public.monthly_bills b on b.billing_month = m.m
   group by m.m
   order by m.m;
end $fn$;

-- Collector-wise collection between two dates (payment-date basis).
create or replace function public.collector_series(
  p_from date default null,
  p_to date default null
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
   group by pr.id, pr.full_name
  having count(p.id) > 0
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

-- Daily collection report - who collected how much on a given day.
create or replace function public.daily_collection_report(p_date date default null)
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
   where p.voided_at is null
     and p.payment_date = v_date
   group by pr.id, pr.full_name
   order by coalesce(sum(p.amount), 0) desc;
end $fn$;

-- Day-by-day totals for one collector over a range (collector report).
create or replace function public.collector_daily_breakdown(
  p_collector_id uuid,
  p_from date,
  p_to date
)
returns table (
  collection_date date,
  payments_count bigint,
  total_amount numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_collector_id <> public.require_active() and not public.is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = '42501';
  end if;

  return query
  select p.payment_date, count(*), coalesce(sum(p.amount), 0)::numeric
    from public.payments p
   where p.collected_by = p_collector_id
     and p.voided_at is null
     and p.payment_date between p_from and p_to
   group by p.payment_date
   order by p.payment_date desc;
end $fn$;

-- ----------------------------------------------------------------------------
-- Profile / user management
-- ----------------------------------------------------------------------------
create or replace function public.update_own_profile(
  p_full_name text,
  p_phone text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.require_active();
  v_old public.profiles;
  v_new public.profiles;
begin
  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'NAME_REQUIRED' using errcode = '22023';
  end if;

  select * into v_old from public.profiles where id = v_uid;

  -- Deliberately cannot touch role or is_active.
  update public.profiles
     set full_name = btrim(p_full_name),
         phone     = nullif(btrim(p_phone), '')
   where id = v_uid
  returning * into v_new;

  perform public.write_audit('profile.updated', 'profile', v_uid, to_jsonb(v_old), to_jsonb(v_new));
  return v_new;
end $fn$;

create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_full_name text,
  p_phone text,
  p_role public.user_role,
  p_is_active boolean
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := public.require_admin();
  v_old public.profiles;
  v_new public.profiles;
begin
  if length(btrim(coalesce(p_full_name, ''))) = 0 then
    raise exception 'NAME_REQUIRED' using errcode = '22023';
  end if;

  select * into v_old from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Never let an admin lock themselves out of the system.
  if p_user_id = v_uid and (p_role <> 'admin' or not p_is_active) then
    raise exception 'CANNOT_DEMOTE_SELF' using errcode = '42501';
  end if;

  -- Never remove the last admin.
  if v_old.role = 'admin' and (p_role <> 'admin' or not p_is_active) then
    if (select count(*) from public.profiles where role = 'admin' and is_active) <= 1 then
      raise exception 'LAST_ADMIN' using errcode = '42501';
    end if;
  end if;

  update public.profiles
     set full_name = btrim(p_full_name),
         phone     = nullif(btrim(p_phone), ''),
         role      = p_role,
         is_active = p_is_active
   where id = p_user_id
  returning * into v_new;

  perform public.write_audit('profile.updated_by_admin', 'profile', p_user_id, to_jsonb(v_old), to_jsonb(v_new));
  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- Client writes (audited)
-- ----------------------------------------------------------------------------
create or replace function public.upsert_client(
  p_id uuid,
  p_client_code text,
  p_name text,
  p_phone text,
  p_address text,
  p_monthly_bill numeric,
  p_start_date date,
  p_status public.client_status,
  p_notes text
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.clients;
  v_new public.clients;
  v_amount numeric(12,2) := round(coalesce(p_monthly_bill, 0), 2);
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

  if p_id is null then
    insert into public.clients (client_code, name, phone, address, monthly_bill, start_date, status, notes)
    values (
      upper(btrim(p_client_code)), btrim(p_name), nullif(btrim(p_phone), ''),
      nullif(btrim(p_address), ''), v_amount,
      coalesce(p_start_date, public.dhaka_today()),
      coalesce(p_status, 'active'), nullif(btrim(p_notes), '')
    )
    returning * into v_new;

    perform public.write_audit('client.created', 'client', v_new.id, null, to_jsonb(v_new));
  else
    select * into v_old from public.clients where id = p_id for update;
    if not found then
      raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
    end if;

    update public.clients
       set client_code  = upper(btrim(p_client_code)),
           name         = btrim(p_name),
           phone        = nullif(btrim(p_phone), ''),
           address      = nullif(btrim(p_address), ''),
           monthly_bill = v_amount,
           start_date   = coalesce(p_start_date, v_old.start_date),
           status       = coalesce(p_status, v_old.status),
           notes        = nullif(btrim(p_notes), '')
     where id = p_id
    returning * into v_new;

    perform public.write_audit('client.updated', 'client', p_id, to_jsonb(v_old), to_jsonb(v_new));
  end if;

  return v_new;
end $fn$;

create or replace function public.set_client_status(
  p_client_id uuid,
  p_status public.client_status
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.clients;
  v_new public.clients;
begin
  perform public.require_admin();

  select * into v_old from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.clients set status = p_status where id = p_client_id returning * into v_new;
  perform public.write_audit('client.status_changed', 'client', p_client_id, to_jsonb(v_old), to_jsonb(v_new));
  return v_new;
end $fn$;

-- Hard delete is only possible while a client has no financial history.
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

  if exists (select 1 from public.payments where client_id = p_client_id) then
    raise exception 'CLIENT_HAS_PAYMENTS' using errcode = '42501';
  end if;

  delete from public.monthly_bills where client_id = p_client_id;
  delete from public.clients where id = p_client_id;

  perform public.write_audit('client.deleted', 'client', p_client_id, to_jsonb(v_old), null);
end $fn$;


-- >>>>>>>>>>>>>>>>>>>>>>>>  0003_rls_policies.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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


-- >>>>>>>>>>>>>>>>>>>>>>>>  0004_bill_adjustments.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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


-- >>>>>>>>>>>>>>>>>>>>>>>>  0005_areas_and_rates.sql  <<<<<<<<<<<<<<<<<<<<<<<<

-- =============================================================================
-- 0005_areas_and_rates.sql
--
-- Two additions, both deliberately shallow:
--
-- 1. AREAS. Clients belong to a geographical area. The area lives on the
--    client, not on the bill or payment - so moving a client between areas
--    changes where they are counted from now on and rewrites nothing
--    historical (spec section 27).
--
-- 2. RATE HISTORY. `clients.monthly_bill` already behaved correctly: bill
--    generation copies it into monthly_bills.bill_amount, and ON CONFLICT DO
--    NOTHING means an existing bill is never rewritten. So changing a rate
--    already only affected future bills.
--
--    What it could NOT do was schedule a change ("৳1,200 from September") or
--    record why. client_rate_history adds exactly that: generation asks for
--    the rate effective for the month being generated. `clients.monthly_bill`
--    stays as the current rate so nothing existing breaks.
--
-- Safe to re-run.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Areas
-- ----------------------------------------------------------------------------
create table if not exists public.areas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(btrim(name)) > 0),
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists areas_active_idx on public.areas (is_active, name);

drop trigger if exists areas_set_updated_at on public.areas;
create trigger areas_set_updated_at
  before update on public.areas
  for each row execute function public.set_updated_at();

-- Nullable: existing clients have no area until one is assigned, and a client
-- without an area must never be invisible. `on delete restrict` means an area
-- in use cannot be removed - deactivate it instead.
alter table public.clients
  add column if not exists area_id uuid references public.areas(id) on delete restrict;

create index if not exists clients_area_idx on public.clients (area_id);
create index if not exists clients_area_status_idx on public.clients (area_id, status);

-- ----------------------------------------------------------------------------
-- Rate history
-- ----------------------------------------------------------------------------
create table if not exists public.client_rate_history (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients(id) on delete cascade,
  monthly_bill   numeric(12,2) not null check (monthly_bill >= 0),
  -- Always the 1st of a month: a rate applies to whole billing months.
  effective_from date not null check (effective_from = date_trunc('month', effective_from)::date),
  reason         text,
  changed_by     uuid references public.profiles(id) on delete restrict,
  created_at     timestamptz not null default now(),
  constraint client_rate_history_unique unique (client_id, effective_from)
);

-- The lookup below is "latest effective_from <= month", so index it that way.
create index if not exists client_rate_history_lookup_idx
  on public.client_rate_history (client_id, effective_from desc);

-- ----------------------------------------------------------------------------
-- The rate that applies to a given billing month.
--
-- Falls back to clients.monthly_bill when no history row covers the month,
-- which is the case for every client until someone schedules a change.
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
    (select c.monthly_bill from public.clients c where c.id = p_client_id)
  )
$fn$;

-- ----------------------------------------------------------------------------
-- Area management (admin only)
-- ----------------------------------------------------------------------------
create or replace function public.upsert_area(
  p_id uuid,
  p_name text,
  p_description text default null,
  p_is_active boolean default true
)
returns public.areas
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.areas;
  v_new public.areas;
begin
  perform public.require_admin();

  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'AREA_NAME_REQUIRED' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.areas (name, description, is_active)
    values (btrim(p_name), nullif(btrim(p_description), ''), coalesce(p_is_active, true))
    returning * into v_new;
    perform public.write_audit('area.created', 'area', v_new.id, null, to_jsonb(v_new));
  else
    select * into v_old from public.areas where id = p_id for update;
    if not found then
      raise exception 'AREA_NOT_FOUND' using errcode = 'P0002';
    end if;

    update public.areas
       set name        = btrim(p_name),
           description = nullif(btrim(p_description), ''),
           is_active   = coalesce(p_is_active, v_old.is_active)
     where id = p_id
    returning * into v_new;
    perform public.write_audit('area.updated', 'area', p_id, to_jsonb(v_old), to_jsonb(v_new));
  end if;

  return v_new;
end $fn$;

-- Removable only while empty; otherwise deactivate, so history keeps its area.
create or replace function public.delete_area(p_area_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.areas;
  v_count integer;
begin
  perform public.require_admin();

  select * into v_old from public.areas where id = p_area_id for update;
  if not found then
    raise exception 'AREA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select count(*) into v_count from public.clients where area_id = p_area_id;
  if v_count > 0 then
    raise exception 'AREA_HAS_CLIENTS|%', v_count using errcode = '42501';
  end if;

  delete from public.areas where id = p_area_id;
  perform public.write_audit('area.deleted', 'area', p_area_id, to_jsonb(v_old), null);
end $fn$;

-- Reassigning an area affects future reporting only. Bills and payments are
-- never touched (spec section 27).
create or replace function public.set_client_area(
  p_client_id uuid,
  p_area_id uuid
)
returns public.clients
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old public.clients;
  v_new public.clients;
begin
  perform public.require_admin();

  select * into v_old from public.clients where id = p_client_id for update;
  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_area_id is not null and not exists (select 1 from public.areas where id = p_area_id) then
    raise exception 'AREA_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.clients set area_id = p_area_id where id = p_client_id returning * into v_new;
  perform public.write_audit('client.area_changed', 'client', p_client_id, to_jsonb(v_old), to_jsonb(v_new));
  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- Scheduling a rate change (admin only)
--
-- Only ever writes forward: the effective month cannot be earlier than the
-- current month, so an already-billed month can never be re-rated by accident.
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

  -- Keep clients.monthly_bill meaning "the rate in force today".
  if v_month <= public.dhaka_current_month() then
    update public.clients set monthly_bill = v_amount where id = p_client_id;
  end if;

  perform public.write_audit('client.rate_changed', 'client', p_client_id, null, to_jsonb(v_row));
  return v_row;
end $fn$;

-- ----------------------------------------------------------------------------
-- Bill generation now asks for the rate effective for the month it is billing.
-- Behaviour is identical for every client without scheduled rate history.
-- ----------------------------------------------------------------------------
create or replace function public.generate_monthly_bills(p_billing_month date)
returns table (created_count integer, skipped_count integer, billed_amount numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month     date := date_trunc('month', p_billing_month)::date;
  v_month_end date := (date_trunc('month', p_billing_month) + interval '1 month - 1 day')::date;
  v_eligible  integer := 0;
  v_created   integer := 0;
  v_billed    numeric(12,2) := 0;
begin
  perform public.require_admin();

  if v_month > public.dhaka_current_month() then
    raise exception 'FUTURE_BILLING_MONTH' using errcode = '22023';
  end if;

  select count(*) into v_eligible
    from public.clients
   where status = 'active'
     and start_date <= v_month_end;

  with inserted as (
    insert into public.monthly_bills (client_id, billing_month, bill_amount)
    select c.id, v_month, public.client_rate_for_month(c.id, v_month)
      from public.clients c
     where c.status = 'active'
       and c.start_date <= v_month_end
    on conflict (client_id, billing_month) do nothing
    returning bill_amount
  )
  select count(*)::integer, coalesce(sum(bill_amount), 0)
    into v_created, v_billed
    from inserted;

  perform public.write_audit(
    'bills.generated', 'monthly_bill', null, null,
    jsonb_build_object(
      'billing_month', v_month,
      'created', v_created,
      'skipped', v_eligible - v_created,
      'billed_amount', v_billed
    )
  );

  created_count := v_created;
  skipped_count := v_eligible - v_created;
  billed_amount := v_billed;
  return next;
end $fn$;

create or replace function public.generate_client_bill(
  p_client_id uuid,
  p_billing_month date
)
returns public.monthly_bills
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month  date := date_trunc('month', p_billing_month)::date;
  v_client public.clients;
  v_bill   public.monthly_bills;
begin
  perform public.require_admin();

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_client.status <> 'active' then
    raise exception 'CLIENT_INACTIVE' using errcode = '22023';
  end if;
  if v_month > public.dhaka_current_month() then
    raise exception 'FUTURE_BILLING_MONTH' using errcode = '22023';
  end if;

  select * into v_bill
    from public.monthly_bills
   where client_id = p_client_id and billing_month = v_month;

  if found then
    raise exception 'BILL_ALREADY_EXISTS' using errcode = '23505';
  end if;

  insert into public.monthly_bills (client_id, billing_month, bill_amount)
  values (p_client_id, v_month, public.client_rate_for_month(p_client_id, v_month))
  returning * into v_bill;

  perform public.write_audit('bill.created', 'monthly_bill', v_bill.id, null, to_jsonb(v_bill));
  return v_bill;
end $fn$;

-- ----------------------------------------------------------------------------
-- upsert_client gains p_area_id.
--
-- Dropped first: adding a parameter creates a NEW signature, so CREATE OR
-- REPLACE would leave two overloads behind and PostgREST could not choose
-- between them.
-- ----------------------------------------------------------------------------
-- Both signatures: the 9-arg original, and the 10-arg version this file
-- creates - otherwise re-running collides with the overload left behind by a
-- previous run (0002 recreates the 9-arg one on every pass).
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
  v_old public.clients;
  v_new public.clients;
  v_amount numeric(12,2) := round(coalesce(p_monthly_bill, 0), 2);
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
    insert into public.clients (client_code, name, phone, address, monthly_bill, start_date, status, notes, area_id)
    values (
      upper(btrim(p_client_code)), btrim(p_name), nullif(btrim(p_phone), ''),
      nullif(btrim(p_address), ''), v_amount,
      coalesce(p_start_date, public.dhaka_today()),
      coalesce(p_status, 'active'), nullif(btrim(p_notes), ''), p_area_id
    )
    returning * into v_new;

    perform public.write_audit('client.created', 'client', v_new.id, null, to_jsonb(v_new));
  else
    select * into v_old from public.clients where id = p_id for update;
    if not found then
      raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0002';
    end if;

    update public.clients
       set client_code  = upper(btrim(p_client_code)),
           name         = btrim(p_name),
           phone        = nullif(btrim(p_phone), ''),
           address      = nullif(btrim(p_address), ''),
           monthly_bill = v_amount,
           start_date   = coalesce(p_start_date, v_old.start_date),
           status       = coalesce(p_status, v_old.status),
           notes        = nullif(btrim(p_notes), ''),
           area_id      = p_area_id
     where id = p_id
    returning * into v_new;

    -- A rate change made here takes effect from the current month onwards.
    -- Months already billed keep their snapshot, so history never moves.
    if v_old.monthly_bill is distinct from v_amount then
      insert into public.client_rate_history (client_id, monthly_bill, effective_from, reason, changed_by)
      values (p_id, v_amount, public.dhaka_current_month(), 'Updated from client form', auth.uid())
      on conflict (client_id, effective_from) do update
        set monthly_bill = excluded.monthly_bill,
            changed_by   = excluded.changed_by,
            created_at   = now();
    end if;

    perform public.write_audit('client.updated', 'client', p_id, to_jsonb(v_old), to_jsonb(v_new));
  end if;

  return v_new;
end $fn$;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
alter table public.areas               enable row level security;
alter table public.client_rate_history enable row level security;

drop policy if exists areas_select on public.areas;
create policy areas_select on public.areas
  for select to authenticated
  using (public.is_active_user());

drop policy if exists areas_admin_write on public.areas;
create policy areas_admin_write on public.areas
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Rate history is an admin concern; collectors only ever see the bill itself.
drop policy if exists client_rate_history_select on public.client_rate_history;
create policy client_rate_history_select on public.client_rate_history
  for select to authenticated
  using (public.is_admin());

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
         'upsert_area', 'delete_area', 'set_client_area',
         'set_client_rate', 'client_rate_for_month', 'upsert_client'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;


-- >>>>>>>>>>>>>>>>>>>>>>>>  0006_analytics.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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


-- >>>>>>>>>>>>>>>>>>>>>>>>  0007_collection_report.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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


-- >>>>>>>>>>>>>>>>>>>>>>>>  0008_normalize_3nf.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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


-- >>>>>>>>>>>>>>>>>>>>>>>>  0009_server_side_totals.sql  <<<<<<<<<<<<<<<<<<<<<<<<

-- =============================================================================
-- 0009_server_side_totals.sql
-- Move the "total under the table" figures into the database.
--
-- THE BUG THIS FIXES
--
-- src/lib/queries/payments.ts computed its totals in JavaScript: it selected
-- every matching row and added the column up in a reduce().
--
--     .select("amount, monthly_bills!inner(...)")   -- no range, no limit
--     .reduce((sum, row) => sum + Number(row.amount), 0)
--
-- Supabase's Data API caps a response at the project's "Max rows" setting,
-- which defaults to 1000. Past a thousand matching rows the cap is applied
-- silently - no error, no flag - so the total under the table was the sum of
-- the FIRST THOUSAND payments and nothing more, while the row count beside it
-- (which came from an exact count) stayed right. A money figure that quietly
-- stops growing is the worst kind of wrong in a ledger.
--
-- It was reachable from the default view of four screens, none of which apply
-- a date filter until the user picks one:
--
--   /collections        every payment ever recorded
--   /dashboard          same sum, to render six rows
--   /my/collections     every payment that collector ever took
--   /my/dashboard       same sum, to render eight rows
--
-- So it was also transferring the whole payment history to add up one column.
--
-- THE FIX
--
-- Two aggregate functions. sum() happens next to the data, one row comes back,
-- and "Max rows" has nothing to truncate.
--
-- SECURITY INVOKER - deliberately, and this is the point worth not breaking.
-- These read payments and monthly_bills as the CALLER, so the RLS policies from
-- 0003 apply exactly as they did to the REST query being replaced:
--
--     payments_select: is_admin() or collected_by = auth.uid()
--
-- A collector therefore aggregates only their own payments, with no role check
-- needed in here. Making these SECURITY DEFINER would hand every collector the
-- whole business's collection total - so they are not, and must not become,
-- SECURITY DEFINER. (That is also why they cannot call require_active(): it is
-- revoked from `authenticated`, and would fail as the invoker. RLS is the
-- authorisation boundary here, as it is for the query this replaces.)
-- =============================================================================


-- ----------------------------------------------------------------------------
-- ILIKE pattern escaping.
--
-- The client search filter interpolates a user-typed term into an ILIKE
-- pattern, where % and _ are wildcards. Escaping in here rather than in
-- TypeScript keeps the function safe to call from anywhere - callers pass the
-- raw term and cannot forget.
--
-- Backslash first, or it would double the escapes added after it.
-- ----------------------------------------------------------------------------
create or replace function public.like_escape(p_term text)
returns text
language sql
immutable
parallel safe
as $fn$
  select replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_')
$fn$;

comment on function public.like_escape(text) is
  'Neutralises \, %% and _ so a user-typed term can be interpolated into an '
  'ILIKE pattern as a literal.';


-- ----------------------------------------------------------------------------
-- payment_totals - the aggregate behind listPayments().sum
--
-- Every filter mirrors applyPaymentFilters() in src/lib/queries/payments.ts,
-- including the inner joins: a payment always has a bill and a bill always has
-- a client, so joining them narrows nothing, it only lets the client-shaped
-- filters reach the columns they need. payments carries no client_id of its own
-- (0008), which is why p_client_id filters the BILL.
-- ----------------------------------------------------------------------------
create or replace function public.payment_totals(
  p_from           date default null,
  p_to             date default null,
  p_billing_month  date default null,
  p_collector_id   uuid default null,
  p_client_id      uuid default null,
  p_area_id        uuid default null,
  p_method         public.payment_method default null,
  p_search         text default null,
  p_include_voided boolean default false
)
returns jsonb
language sql
stable
as $fn$
  select jsonb_build_object(
    'total_amount',  coalesce(sum(p.amount), 0),
    'payment_count', count(*)
  )
    from public.payments p
    join public.monthly_bills b on b.id = p.monthly_bill_id
    join public.clients c       on c.id = b.client_id
   where (p_include_voided or p.voided_at is null)
     and (p_from          is null or p.payment_date   >= p_from)
     and (p_to            is null or p.payment_date   <= p_to)
     and (p_billing_month is null or b.billing_month   = p_billing_month)
     and (p_collector_id  is null or p.collected_by    = p_collector_id)
     and (p_client_id     is null or b.client_id       = p_client_id)
     and (p_area_id       is null or c.area_id         = p_area_id)
     and (p_method        is null or p.payment_method  = p_method)
     and (
       p_search is null
       or btrim(p_search) = ''
       or c.search_text ilike '%' || public.like_escape(btrim(p_search)) || '%'
     )
$fn$;

comment on function public.payment_totals(date, date, date, uuid, uuid, uuid, public.payment_method, text, boolean) is
  'Sum and count of payments matching the collections filters. SECURITY '
  'INVOKER: RLS scopes a collector to their own payments. Replaces summing '
  'every returned row in the application, which the API row cap silently '
  'truncated past 1000 rows.';


-- ----------------------------------------------------------------------------
-- bill_totals - the aggregate behind listBills().totals
--
-- Same story, one month at a time. `billed` is the ADJUSTED total, so
-- paid + due always reconciles to it; the original and the adjustment are
-- returned alongside so the ladder on the bills screen still adds up.
-- ----------------------------------------------------------------------------
create or replace function public.bill_totals(
  p_billing_month date,
  p_status        public.bill_status default null,
  p_area_id       uuid default null,
  p_search        text default null
)
returns jsonb
language sql
stable
as $fn$
  select jsonb_build_object(
    'original_amount',   coalesce(sum(b.bill_amount), 0),
    'adjustment_amount', coalesce(sum(b.adjustment_amount), 0),
    'adjusted_amount',   coalesce(sum(b.adjusted_amount), 0),
    'paid_amount',       coalesce(sum(b.paid_amount), 0),
    'due_amount',        coalesce(sum(b.due_amount), 0),
    'bill_count',        count(*)
  )
    from public.monthly_bills b
    join public.clients c on c.id = b.client_id
   where b.billing_month = p_billing_month
     and (p_status  is null or b.status  = p_status)
     and (p_area_id is null or c.area_id = p_area_id)
     and (
       p_search is null
       or btrim(p_search) = ''
       or c.search_text ilike '%' || public.like_escape(btrim(p_search)) || '%'
     )
$fn$;

comment on function public.bill_totals(date, public.bill_status, uuid, text) is
  'Billed / adjusted / paid / due totals for one billing month, with the same '
  'filters as the bills list. SECURITY INVOKER, so RLS applies.';


-- ----------------------------------------------------------------------------
-- due_totals - the headline figures on the Due Report
--
-- This one was capped by the application rather than by the API: getDueReport()
-- asks for `.limit(500)` and then reported the sum, the bill count and the
-- distinct client count of whatever came back. The table footer calls that
-- number "Grand Total". Past 500 outstanding bills it was the total of the 500
-- largest and nothing more.
--
-- Capping the LIST is reasonable - it is a report table, nobody scrolls three
-- thousand rows. Capping the TOTAL is not. So the rows stay limited and these
-- three figures now describe the whole filtered set.
--
-- client_count is a distinct count over clients, not bills: one client with
-- eight unpaid months is one client who owes money, not eight.
-- ----------------------------------------------------------------------------
create or replace function public.due_totals(
  p_billing_month date default null,
  p_area_id       uuid default null,
  p_min_due       numeric default null,
  p_search        text default null
)
returns jsonb
language sql
stable
as $fn$
  select jsonb_build_object(
    'total_due',    coalesce(sum(b.due_amount), 0),
    'bill_count',   count(*),
    'client_count', count(distinct b.client_id)
  )
    from public.monthly_bills b
    join public.clients c on c.id = b.client_id
   where b.due_amount > 0
     and (p_billing_month is null or b.billing_month = p_billing_month)
     and (p_area_id       is null or c.area_id       = p_area_id)
     and (p_min_due       is null or b.due_amount   >= p_min_due)
     and (
       p_search is null
       or btrim(p_search) = ''
       or c.search_text ilike '%' || public.like_escape(btrim(p_search)) || '%'
     )
$fn$;

comment on function public.due_totals(date, uuid, numeric, text) is
  'True outstanding total, bill count and distinct client count for the Due '
  'Report, independent of the row limit applied to the list itself. SECURITY '
  'INVOKER, so RLS applies.';


-- ----------------------------------------------------------------------------
-- Privileges. Postgres grants EXECUTE to PUBLIC by default, which would expose
-- these to anon.
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
       and p.proname in ('payment_totals', 'bill_totals', 'due_totals', 'like_escape')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;


-- >>>>>>>>>>>>>>>>>>>>>>>>  0010_multi_month_collection.sql  <<<<<<<<<<<<<<<<<<<<<<<<

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

