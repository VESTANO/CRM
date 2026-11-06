-- The live Attendance page reads these tables directly through Supabase RLS.
-- Keep an Admin inside their own store; only Super Admin remains global.

create or replace function public.can_view_store_member(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    p_user_id = auth.uid()
    or public.current_user_role() = 'super_admin'
    or (
      public.current_user_role() in ('admin','manager')
      and exists (
        select 1 from public.profiles actor join public.profiles target on target.id = p_user_id
        where actor.id = auth.uid() and actor.store_id = target.store_id
      )
    ), false
  );
$$;

revoke all on function public.can_view_store_member(uuid) from public, anon;
grant execute on function public.can_view_store_member(uuid) to authenticated, service_role;

drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_store_admin on public.profiles for select to authenticated
  using(public.can_view_store_member(id));

drop policy if exists entries_read_allowed on public.timesheet_entries;
create policy entries_read_store_allowed on public.timesheet_entries for select to authenticated
  using(public.current_user_role() is not null and public.can_view_store_member(user_id));

drop policy if exists attendance_read_allowed on public.attendance_records;
create policy attendance_read_store_allowed on public.attendance_records for select to authenticated
  using(public.current_user_role() is not null and public.can_view_store_member(user_id));

-- Biometric devices and their raw mapping configuration are global hardware
-- controls, so keep them exclusive to the Super Admin.
drop policy if exists devices_read_admin on public.attendance_devices;
create policy devices_read_super_admin on public.attendance_devices for select to authenticated
  using(public.current_user_role() = 'super_admin');
drop policy if exists mappings_read_admin on public.attendance_mappings;
create policy mappings_read_super_admin on public.attendance_mappings for select to authenticated
  using(public.current_user_role() = 'super_admin');

create or replace function public.get_dashboard_totals()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare result jsonb;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  with visible_entries as (
    select * from public.timesheet_entries where public.can_view_store_member(user_id)
  )
  select jsonb_build_object(
    'hours',coalesce(sum(total_hours) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'overtime',coalesce(sum(overtime) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'billable',coalesce(sum(total_hours) filter (where billable),0),
    'pending',count(*) filter (where approval_status='Submitted'),
    'employees',(select count(*) from public.profiles where active and role not in ('super_admin','admin') and public.can_view_store_member(id))
  ) into result from visible_entries;
  return result;
end;
$$;

notify pgrst, 'reload schema';
