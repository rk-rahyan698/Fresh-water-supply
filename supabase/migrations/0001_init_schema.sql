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
