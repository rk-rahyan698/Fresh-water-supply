-- =============================================================================
-- 0011_collection_matrix_by_bill.sql
-- The collection report, by the month each payment PAID FOR.
--
-- THE CONFUSION THIS FIXES
--
--   collection_matrix() (0007) puts every payment under the calendar month it
--   was RECEIVED. Abdul Khan owes August and September at ৳500 and pays ৳1,000
--   on 11 September. The ledger is right - record_collection() applied ৳500 to
--   August and ৳500 to September, oldest first, and both bills are PAID - but
--   the report showed:
--
--       Monthly bill ৳500 | AUG 0 | SEP 1,000
--
--   which reads as "August unpaid, September overpaid". Neither is true.
--
--   That view is not wrong, it answers a different question - how much cash
--   came in during September - and it stays available. But it is not the
--   question an owner scanning a row of months is asking, which is "has each
--   month been paid?". This function answers that one:
--
--       Monthly bill ৳500 | AUG 500 | SEP 500
--
-- WHAT A CELL MEANS
--
--   paid_amounts[m]  what has been paid toward month m's bill, whenever it was
--                    paid - including a January payment against December's
--                    bill, which lands under December of the bill's year.
--   due_amounts[m]   what is still owed on that bill (after adjustments), so
--                    the screen can show an unpaid month as unpaid rather than
--                    as an ambiguous 0.
--
--   Both are NULL where the client has no bill for that month. "Not billed"
--   and "billed and unpaid" must not look alike.
--
--   The collector filter narrows paid_amounts to that collector's payments.
--   due_amounts is the bill's own figure and ignores it: nobody collects a
--   due, it is simply what the bill still needs.
--
-- WHY A NEW FUNCTION
--
--   Changing collection_matrix()'s return shape would need DROP + CREATE, and
--   re-running setup.sql would then fail at 0007/0008, which CREATE OR REPLACE
--   the old shape. setup.sql is documented, and tested, as safe to re-run.
-- =============================================================================

create or replace function public.collection_matrix_by_bill(
  p_year         integer,
  p_area_id      uuid default null,
  p_collector_id uuid default null
)
returns table (
  client_id     uuid,
  client_code   text,
  client_name   text,
  area_id       uuid,
  area_name     text,
  paid_amounts  numeric[],
  due_amounts   numeric[],
  year_total    numeric,
  year_due      numeric,
  payment_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Same access as collection_matrix(), the view this sits beside.
  perform public.require_admin();

  return query
  select c.id,
         c.client_code,
         c.name,
         c.area_id,
         a.name,
         array_agg(paid.amount   order by gs.m)::numeric[],
         array_agg(b.due_amount  order by gs.m)::numeric[],
         coalesce(sum(paid.amount), 0)::numeric,
         coalesce(sum(b.due_amount), 0)::numeric,
         coalesce(sum(paid.cnt), 0)::bigint
    from public.clients c
    left join public.areas a on a.id = c.area_id
   -- Every client gets twelve months, and every client gets a row - the same
   -- "clients who paid nothing still appear" rule collection_matrix() keeps.
   cross join generate_series(1, 12) as gs(m)
    left join public.monthly_bills b
           on b.client_id = c.id
          and b.billing_month = make_date(p_year, gs.m, 1)
   -- LATERAL, so the collector and void predicates stay inside and cannot
   -- turn the outer joins inner. With no bill it yields NULL, not 0.
   cross join lateral (
         select case when b.id is null then null
                     else coalesce(sum(p.amount), 0) end::numeric as amount,
                count(p.id)                                         as cnt
           from public.payments p
          where p.monthly_bill_id = b.id
            and p.voided_at is null
            and (p_collector_id is null or p.collected_by = p_collector_id)
       ) paid
   where (p_area_id is null or c.area_id = p_area_id)
   group by c.id, c.client_code, c.name, c.area_id, a.name
   order by c.name;
end $fn$;

comment on function public.collection_matrix_by_bill(integer, uuid, uuid) is
  'Client x Month by BILLING month: paid toward each month''s bill and what is '
  'still due on it (NULL where not billed). The by-payment-date view is '
  'collection_matrix().';


-- -----------------------------------------------------------------------------
-- Years for the report's year selector.
--
-- payment_years() (0007) only knows years that have payments. By billing month,
-- a year matters as soon as it has bills - on 1 January the new year's bills
-- exist before anyone has paid one, and the report must be able to show them.
-- -----------------------------------------------------------------------------
create or replace function public.collection_report_years()
returns table (report_year integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select y from (
    select extract(year from b.billing_month)::integer as y from public.monthly_bills b
    union
    select extract(year from p.payment_date)::integer from public.payments p
  ) years
  where public.is_admin()
  order by y desc
$fn$;

comment on function public.collection_report_years() is
  'Years with bills or payments, newest first. Empty for non-admins.';


do $grants$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('collection_matrix_by_bill', 'collection_report_years')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
