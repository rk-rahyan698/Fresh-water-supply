-- =============================================================================
-- 0013_staff_names.sql
-- Staff names for collectors, without opening up the profiles table.
--
-- THE PROBLEM THIS FIXES
--
--   profiles_select (0003) lets a collector read exactly one profile: their
--   own. That is right for emails, phones and roles, but it also hid names the
--   collector's own screens print. On My Submissions every "Received by" came
--   back blank, because the person who received the cash is the owner, and the
--   embedded profile was silently null under RLS. The owner's screens were
--   fine, which is why it looked like a display bug rather than an access one.
--
-- WHY A FUNCTION AND NOT A WIDER POLICY
--
--   A select policy is row-level: letting collectors read the owner's row would
--   hand them the owner's email and phone with it. This returns id and
--   full_name only, for ids the caller already holds (from a submission or a
--   bill they can see). Deactivated staff are included on purpose - an old
--   submission should still say who took the cash.
-- =============================================================================

create or replace function public.staff_names(p_ids uuid[])
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  perform public.require_active();

  return query
  select pr.id, pr.full_name
    from public.profiles pr
   where pr.id = any(coalesce(p_ids, '{}'::uuid[]));
end $fn$;

comment on function public.staff_names(uuid[]) is
  'id and full_name for the given staff ids, readable by any active user. '
  'Names only: profiles RLS still hides every other column from collectors.';


do $grants$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('staff_names')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated', fn.sig);
  end loop;
end $grants$;
