begin;
-- Keep the existing no-argument RPC compatible for store accounts. Super Admin
-- totals require the selected store and never aggregate unrelated stores.
create function public.get_store_dashboard_totals(p_store_id uuid)
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
create or replace function public.get_dashboard_totals() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select public.get_store_dashboard_totals(null::uuid);
$$;
revoke all on function public.get_store_dashboard_totals(uuid) from public,anon;
grant execute on function public.get_store_dashboard_totals(uuid) to authenticated,service_role;

-- The approval RPC runs with elevated database rights, so RLS alone is not enough.
create or replace function public.review_timesheet_entry(p_id uuid,p_approval_status text,p_approval_comment text)
returns public.timesheet_entries language plpgsql security definer set search_path=public,pg_temp as $$
declare reviewer public.profiles; result public.timesheet_entries;
begin
  select * into reviewer from public.profiles where id=auth.uid() and active and role in ('super_admin','admin');
  if reviewer.id is null then raise exception 'Only admins can approve entries.'; end if;
  if p_approval_status is null or p_approval_status not in ('Approved','Rejected','Submitted') then
    raise exception 'Invalid approval status.';
  end if;
  update public.timesheet_entries set approval_status=p_approval_status,
    approval_comment=coalesce(trim(p_approval_comment),''),approved_by=reviewer.name,approved_at=now()
  where id=p_id and public.can_view_store_member(user_id) returning * into result;
  if result.id is null then raise exception 'Timesheet entry not found in your store.'; end if;
  return result;
end $$;

-- A biometric code already linked to a store must not silently transfer its
-- existing punches into a different store.
create or replace function public.map_attendance_employee(p_punch_code text,p_user_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare employee public.profiles; matched integer; code text;
begin
  if public.current_user_role() is distinct from 'super_admin' and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Only Super Admins can map attendance.';
  end if;
  code:=trim(coalesce(p_punch_code,''));
  if code='' then raise exception 'Punch code is required.'; end if;
  select * into employee from public.profiles where id=p_user_id and active and store_id is not null;
  if employee.id is null then raise exception 'Store employee not found.'; end if;
  if exists(select 1 from public.attendance_mappings m join public.profiles p on p.id=m.user_id where m.punch_code=code and p.store_id is distinct from employee.store_id)
    or exists(select 1 from public.attendance_records r join public.profiles p on p.id=r.user_id where r.punch_code=code and p.store_id is distinct from employee.store_id) then
    raise exception 'This punch code already belongs to another store.';
  end if;
  insert into public.attendance_mappings(punch_code,user_id) values(code,employee.id)
    on conflict(punch_code) do update set user_id=excluded.user_id,updated_at=now();
  update public.attendance_records set user_id=employee.id,employee_id=employee.employee_id,employee_name=employee.name where punch_code=code;
  get diagnostics matched=row_count;
  return matched;
end $$;
notify pgrst,'reload schema';
commit;
