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
