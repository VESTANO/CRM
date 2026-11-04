-- Consolidate the original Attendance schema into the existing CRM project.
-- Keep CRM identities, roles, login resolver, and auth/profile triggers intact.
begin;

alter table public.profiles
  add column if not exists shift_start_time time not null default '09:30',
  add column if not exists shift_end_time time not null default '17:30';

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  company_name text not null default 'Vestano International Pvt Ltd',
  standard_hours numeric(5,2) not null default 8,
  attendance_last_sync timestamptz,
  attendance_device_config jsonb not null default '{"model":"K90 Pro","serialNumber":"","ipAddress":"","connectionType":"Wi-Fi","mode":"ADMS"}'::jsonb
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  employee_id text not null,
  employee_name text not null,
  work_date date not null,
  project text not null,
  details text not null,
  category text not null,
  start_time time not null,
  end_time time not null,
  break_hours numeric(5,2) not null default 0,
  total_hours numeric(5,2) not null,
  overtime numeric(5,2) not null default 0,
  billable boolean not null default false,
  work_status text not null default 'Completed',
  comments text not null default '',
  approval_status text not null default 'Submitted' check (approval_status in ('Submitted','Approved','Rejected')),
  approval_comment text not null default '',
  approved_by text not null default '',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.attendance_devices (
  serial_number text primary key,
  model text not null default '',
  ip_address text not null default '',
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.attendance_mappings (
  punch_code text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  employee_id text,
  employee_name text not null default 'Unmatched',
  punch_code text not null,
  punched_at timestamptz not null,
  serial_number text not null,
  status text not null default '',
  verify_mode text not null default '',
  raw text not null default '',
  created_at timestamptz not null default now(),
  unique (serial_number,punch_code,punched_at)
);
create index if not exists attendance_records_user_date_idx on public.attendance_records(user_id,punched_at desc);
create index if not exists attendance_records_punch_code_idx on public.attendance_records(punch_code);
create index if not exists timesheet_entries_user_date_idx on public.timesheet_entries(user_id,work_date desc);
create index if not exists timesheet_entries_approval_date_idx on public.timesheet_entries(approval_status,work_date desc);

create or replace function public.attendance_set_updated_at()
returns trigger language plpgsql set search_path = public,pg_temp as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists entries_set_updated_at on public.timesheet_entries;
create trigger entries_set_updated_at before update on public.timesheet_entries
for each row execute function public.attendance_set_updated_at();

create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = public,pg_temp as $$
  select role from public.profiles where id = auth.uid() and active limit 1;
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select coalesce(public.current_user_role() in ('super_admin','admin'),false);
$$;
create or replace function public.is_manager_or_admin()
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select coalesce(public.current_user_role() in ('super_admin','admin','manager'),false);
$$;
create or replace function public.calculate_work_hours(start_value time,end_value time,break_value numeric)
returns numeric language sql immutable set search_path = public,pg_temp as $$
  select greatest(0,round((extract(epoch from (end_value-start_value))/3600-coalesce(break_value,0))::numeric,2));
$$;

create or replace function public.create_timesheet_entry(
  p_work_date date,p_project text,p_details text,p_category text,
  p_start_time time,p_end_time time,p_break_hours numeric,p_billable boolean,
  p_work_status text,p_comments text
)
returns public.timesheet_entries language plpgsql security definer set search_path = public,pg_temp as $$
declare employee public.profiles; result public.timesheet_entries; hours numeric; standard numeric;
begin
  select * into employee from public.profiles where id=auth.uid() and active;
  if employee.id is null then raise exception 'Active employee account required.'; end if;
  if trim(coalesce(p_project,''))='' or trim(coalesce(p_details,''))='' then
    raise exception 'Project and work details are required.';
  end if;
  if p_work_date is null or p_start_time is null or p_end_time is null then
    raise exception 'Work date and times are required.';
  end if;
  if coalesce(p_break_hours,0)<0 then raise exception 'Break hours cannot be negative.'; end if;
  hours := public.calculate_work_hours(p_start_time,p_end_time,p_break_hours);
  select standard_hours into standard from public.app_settings where id;
  insert into public.timesheet_entries (
    user_id,employee_id,employee_name,work_date,project,details,category,
    start_time,end_time,break_hours,total_hours,overtime,billable,work_status,comments
  ) values (
    employee.id,employee.employee_id,employee.name,p_work_date,trim(p_project),trim(p_details),trim(p_category),
    p_start_time,p_end_time,coalesce(p_break_hours,0),hours,greatest(0,hours-standard),
    coalesce(p_billable,false),coalesce(nullif(trim(p_work_status),''),'Completed'),coalesce(trim(p_comments),'')
  ) returning * into result;
  return result;
end;
$$;

create or replace function public.update_timesheet_entry(
  p_id uuid,p_work_date date,p_project text,p_details text,p_category text,
  p_start_time time,p_end_time time,p_break_hours numeric,p_billable boolean,
  p_work_status text,p_comments text
)
returns public.timesheet_entries language plpgsql security definer set search_path = public,pg_temp as $$
declare result public.timesheet_entries; hours numeric; standard numeric;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  select * into result from public.timesheet_entries where id=p_id and user_id=auth.uid() for update;
  if result.id is null or result.approval_status='Approved' then raise exception 'This entry cannot be edited.'; end if;
  if trim(coalesce(p_project,''))='' or trim(coalesce(p_details,''))='' then
    raise exception 'Project and work details are required.';
  end if;
  if p_work_date is null or p_start_time is null or p_end_time is null then
    raise exception 'Work date and times are required.';
  end if;
  if coalesce(p_break_hours,0)<0 then raise exception 'Break hours cannot be negative.'; end if;
  hours := public.calculate_work_hours(p_start_time,p_end_time,p_break_hours);
  select standard_hours into standard from public.app_settings where id;
  update public.timesheet_entries set
    work_date=p_work_date,project=trim(p_project),details=trim(p_details),category=trim(p_category),
    start_time=p_start_time,end_time=p_end_time,break_hours=coalesce(p_break_hours,0),
    total_hours=hours,overtime=greatest(0,hours-standard),billable=coalesce(p_billable,false),
    work_status=coalesce(nullif(trim(p_work_status),''),'Completed'),comments=coalesce(trim(p_comments),''),
    approval_status='Submitted',approval_comment='',approved_by='',approved_at=null
  where id=p_id returning * into result;
  return result;
end;
$$;

create or replace function public.delete_timesheet_entry(p_id uuid)
returns boolean language plpgsql security definer set search_path = public,pg_temp as $$
declare caller_profile_role text;
begin
  caller_profile_role := public.current_user_role();
  if caller_profile_role is null then raise exception 'Active employee account required.'; end if;
  delete from public.timesheet_entries where id=p_id and (
    caller_profile_role='super_admin' or (user_id=auth.uid() and approval_status<>'Approved')
  );
  if not found then raise exception 'This entry cannot be deleted.'; end if;
  return true;
end;
$$;

create or replace function public.review_timesheet_entry(p_id uuid,p_approval_status text,p_approval_comment text)
returns public.timesheet_entries language plpgsql security definer set search_path = public,pg_temp as $$
declare reviewer public.profiles; result public.timesheet_entries;
begin
  select * into reviewer from public.profiles where id=auth.uid() and active and role in ('super_admin','admin');
  if reviewer.id is null then raise exception 'Only admins can approve entries.'; end if;
  if p_approval_status is null or p_approval_status not in ('Approved','Rejected','Submitted') then
    raise exception 'Invalid approval status.';
  end if;
  update public.timesheet_entries set approval_status=p_approval_status,
    approval_comment=coalesce(trim(p_approval_comment),''),approved_by=reviewer.name,approved_at=now()
  where id=p_id returning * into result;
  if result.id is null then raise exception 'Timesheet entry not found.'; end if;
  return result;
end;
$$;

create or replace function public.update_profile_image(p_profile_image text)
returns public.profiles language plpgsql security definer set search_path = public,pg_temp as $$
declare result public.profiles;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  if length(coalesce(p_profile_image,''))>750000 then raise exception 'Profile image is too large.'; end if;
  update public.profiles set profile_image=coalesce(p_profile_image,'') where id=auth.uid() returning * into result;
  return result;
end;
$$;

create or replace function public.get_dashboard_totals()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare result jsonb;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  with visible_entries as (
    select * from public.timesheet_entries where user_id=auth.uid() or public.is_manager_or_admin()
  )
  select jsonb_build_object(
    'hours',coalesce(sum(total_hours) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'overtime',coalesce(sum(overtime) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'billable',coalesce(sum(total_hours) filter (where billable),0),
    'pending',count(*) filter (where approval_status='Submitted'),
    'employees',(select count(*) from public.profiles where active and role not in ('super_admin','admin'))
  ) into result from visible_entries;
  return result;
end;
$$;

create or replace function public.map_attendance_employee(p_punch_code text,p_user_id uuid)
returns integer language plpgsql security definer set search_path = public,pg_temp as $$
declare employee public.profiles; matched integer;
begin
  if not public.is_admin() and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Only admins can map attendance.';
  end if;
  if trim(coalesce(p_punch_code,''))='' then raise exception 'Punch code is required.'; end if;
  select * into employee from public.profiles where id=p_user_id and active;
  if employee.id is null then raise exception 'Employee not found.'; end if;
  insert into public.attendance_mappings(punch_code,user_id) values(trim(p_punch_code),employee.id)
    on conflict(punch_code) do update set user_id=excluded.user_id,updated_at=now();
  update public.attendance_records set user_id=employee.id,employee_id=employee.employee_id,employee_name=employee.name
    where punch_code=trim(p_punch_code);
  get diagnostics matched=row_count;
  return matched;
end;
$$;

alter table public.app_settings enable row level security;
alter table public.timesheet_entries enable row level security;
alter table public.attendance_devices enable row level security;
alter table public.attendance_mappings enable row level security;
alter table public.attendance_records enable row level security;
drop policy if exists settings_read_authenticated on public.app_settings;
create policy settings_read_authenticated on public.app_settings for select to authenticated using(public.current_user_role() is not null);
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
drop policy if exists entries_read_allowed on public.timesheet_entries;
create policy entries_read_allowed on public.timesheet_entries for select to authenticated
  using(public.current_user_role() is not null and (user_id=auth.uid() or public.is_manager_or_admin()));
drop policy if exists devices_read_admin on public.attendance_devices;
create policy devices_read_admin on public.attendance_devices for select to authenticated using(public.is_admin());
drop policy if exists mappings_read_admin on public.attendance_mappings;
create policy mappings_read_admin on public.attendance_mappings for select to authenticated using(public.is_admin());
drop policy if exists attendance_read_allowed on public.attendance_records;
create policy attendance_read_allowed on public.attendance_records for select to authenticated
  using(public.current_user_role() is not null and (user_id=auth.uid() or public.is_admin()));

revoke all on public.app_settings,public.timesheet_entries,public.attendance_devices,public.attendance_mappings,public.attendance_records from anon,authenticated;
grant select on public.app_settings,public.timesheet_entries,public.attendance_devices,public.attendance_mappings,public.attendance_records,public.profiles to authenticated;
grant all on public.app_settings,public.timesheet_entries,public.attendance_devices,public.attendance_mappings,public.attendance_records to service_role;

revoke all on function public.attendance_set_updated_at() from public,anon;
revoke all on function public.current_user_role() from public,anon;
revoke all on function public.is_admin() from public,anon;
revoke all on function public.is_manager_or_admin() from public,anon;
revoke all on function public.calculate_work_hours(time,time,numeric) from public,anon;
revoke all on function public.create_timesheet_entry(date,text,text,text,time,time,numeric,boolean,text,text) from public,anon;
revoke all on function public.update_timesheet_entry(uuid,date,text,text,text,time,time,numeric,boolean,text,text) from public,anon;
revoke all on function public.delete_timesheet_entry(uuid) from public,anon;
revoke all on function public.review_timesheet_entry(uuid,text,text) from public,anon;
revoke all on function public.update_profile_image(text) from public,anon;
revoke all on function public.get_dashboard_totals() from public,anon;
revoke all on function public.map_attendance_employee(text,uuid) from public,anon;
grant execute on function public.current_user_role(),public.is_admin(),public.is_manager_or_admin(),public.calculate_work_hours(time,time,numeric) to authenticated,service_role;
grant execute on function public.create_timesheet_entry(date,text,text,text,time,time,numeric,boolean,text,text),
  public.update_timesheet_entry(uuid,date,text,text,text,time,time,numeric,boolean,text,text),
  public.delete_timesheet_entry(uuid),public.review_timesheet_entry(uuid,text,text),
  public.update_profile_image(text),public.get_dashboard_totals(),public.map_attendance_employee(text,uuid)
to authenticated,service_role;

notify pgrst,'reload schema';
commit;
