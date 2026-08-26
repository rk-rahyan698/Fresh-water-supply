-- =============================================================================
-- setup.sql  -  complete database setup in ONE file
--
-- Convenience for the Supabase SQL Editor: this is migrations 0001, 0002 and
-- 0003 concatenated in order. Paste the whole thing into a new query and Run.
--
-- It lives OUTSIDE supabase/migrations/ on purpose, so `supabase db push`
-- does not apply the same SQL twice. If you use the Supabase CLI, ignore this
-- file and push the migrations folder instead.
--
-- Safe to re-run.
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
create index if not exists payments_client_idx on public.payments (client_id, payment_date desc);
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
create or replace function public.monthly_series(p_months integer default 6)
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
