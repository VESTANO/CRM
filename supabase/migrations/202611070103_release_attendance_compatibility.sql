begin;
-- Keep the published no-argument Attendance RPC compatible with open sessions.
-- The new selected-store interface enforces the same store feature permission.
CREATE OR REPLACE FUNCTION public.get_dashboard_totals()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  with visible_entries as (
    select * from public.timesheet_entries where public.can_view_store_member(user_id) and public.store_feature_enabled_for_user(user_id, 'attendance')
  )
  select jsonb_build_object(
    'hours',coalesce(sum(total_hours) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'overtime',coalesce(sum(overtime) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'billable',coalesce(sum(total_hours) filter (where billable),0),
    'pending',count(*) filter (where approval_status='Submitted'),
    'employees',(select count(*) from public.profiles where active and role not in ('super_admin','admin') and public.can_view_store_member(id) and public.store_feature_enabled_for_user(id, 'attendance'))
  ) into result from visible_entries;
  return result;
end;
$function$
;
create or replace function public.get_store_dashboard_totals(p_store_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles; selected_store uuid; result jsonb;
begin
  select * into actor from public.profiles where id=auth.uid() and active;
  if actor.id is null then raise exception 'Active employee account required.'; end if;
  selected_store:=case when actor.role='super_admin' then p_store_id else actor.store_id end;
  if selected_store is null then raise exception 'Open a store before viewing attendance totals.'; end if;
  if actor.role<>'super_admin' and p_store_id is not null and p_store_id<>actor.store_id then
    raise exception 'This store is not accessible.';
  end if;
  if not exists (select 1 from public.crm_stores where id=selected_store and features->>'attendance'='true') then
    raise exception 'Attendance is not enabled for this store.' using errcode='42501';
  end if;
  with visible_entries as (
    select e.* from public.timesheet_entries e join public.profiles p on p.id=e.user_id
    where p.store_id=selected_store and public.can_view_store_member(p.id)
  )
  select jsonb_build_object(
    'hours',coalesce(sum(total_hours) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'overtime',coalesce(sum(overtime) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'billable',coalesce(sum(total_hours) filter (where billable),0),
    'pending',count(*) filter (where approval_status='Submitted'),
    'employees',(select count(*) from public.profiles where store_id=selected_store and active and role not in ('super_admin','admin') and public.can_view_store_member(id))
  ) into result from visible_entries;
  return result;
end $$;


notify pgrst,'reload schema';
commit;
