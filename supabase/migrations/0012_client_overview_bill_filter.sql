-- =============================================================================
-- 0012_client_overview_bill_filter.sql
-- The client list, filtered by whether each client's bill for a month is paid.
--
-- THE PROBLEM THIS FIXES
--
--   A collector opening Clients saw a name, a code and a monthly rate - and no
--   way to tell who had already paid. Finding the people still to visit meant
--   opening profiles one at a time. The owner's list showed a status badge per
--   row, but could not narrow to "unpaid only" either.
--
-- WHAT THE FILTER MEANS  (p_bill_state, for the month p_month)
--
--   'paid'      the bill exists and its status is paid - including a bill a
--               discount brought to zero. Exactly the rows the Paid badge marks.
--   'due'       the bill exists and still owes money: unpaid OR partial. A
--               collector's question is "who do I still need to see", and a
--               client who paid ৳400 of ৳500 is one of them.
--   'unbilled'  no bill exists for that month (bills not generated yet, or the
--               client started later). Without this, those clients would drop
--               out of both Paid and Unpaid and nobody would notice.
--   NULL        everyone.
--
--   total_count counts the filtered set, so pagination and "N clients" agree
--   with what is on screen.
--
-- WHY A NEW FUNCTION
--
--   Adding a parameter to client_month_overview() changes its signature.
--   CREATE OR REPLACE would leave the old one beside it as an overload, and
--   PostgREST cannot choose between two functions that both accept the same
--   named arguments. Dropping it instead would break the deployed build for
--   the minutes between applying this file and pushing the code that uses the
--   new one, and re-running setup.sql would bring it back through 0006/0008
--   anyway. So, as in 0011: a new function, and the old one is left alone.
--
--   It also escapes the search term with like_escape() (0009), which the old
--   function never did - a search for "10%" matched everything.
-- =============================================================================

create or replace function public.client_month_overview_filtered(
  p_month      date default null,
  p_area_id    uuid default null,
  p_search     text default null,
  p_status     public.client_status default null,
  p_bill_state text default null,
  p_limit      integer default 25,
  p_offset     integer default 0
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
  v_state  text := nullif(btrim(coalesce(p_bill_state, '')), '');
  v_limit  integer := greatest(1, least(coalesce(p_limit, 25), 200));
begin
  -- Collectors may call this: RLS already lets any active user read every
  -- client and bill (0003), so it reveals nothing they could not see before.
  perform public.require_active();

  if v_state is not null and v_state not in ('paid', 'due', 'unbilled') then
    raise exception 'INVALID_BILL_STATE' using errcode = '22023';
  end if;

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
     and (v_search is null or c.search_text ilike '%' || public.like_escape(v_search) || '%')
     -- Keyed on the generated status column, so the filter and the badge on
     -- each row can never disagree.
     and (
           v_state is null
        or (v_state = 'paid'     and b.status = 'paid')
        or (v_state = 'due'      and b.status in ('unpaid', 'partial'))
        or (v_state = 'unbilled' and b.id is null)
         )
   order by c.name, c.id
   limit v_limit offset greatest(coalesce(p_offset, 0), 0);
end $fn$;

comment on function public.client_month_overview_filtered(date, uuid, text, public.client_status, text, integer, integer) is
  'Clients with their bill for one month, filterable by bill state: '
  '''paid'', ''due'' (unpaid or partial), ''unbilled'' (no bill), or NULL for '
  'all. Supersedes client_month_overview(), which is kept for older builds.';


do $grants$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('client_month_overview_filtered')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
