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
