begin;

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
  if trim(coalesce(p_project,''))='' or trim(coalesce(p_details,''))='' then raise exception 'Project and work details are required.'; end if;
  if p_work_date is null or p_start_time is null or p_end_time is null then raise exception 'Work date and times are required.'; end if;
  if p_end_time <= p_start_time then raise exception 'End time must be later than start time.'; end if;
  if coalesce(p_break_hours,0)<0 then raise exception 'Break hours cannot be negative.'; end if;
  if coalesce(p_break_hours,0) >= extract(epoch from (p_end_time-p_start_time))/3600 then raise exception 'Break hours must be shorter than the work period.'; end if;
  hours := public.calculate_work_hours(p_start_time,p_end_time,p_break_hours);
  select standard_hours into standard from public.app_settings where id;
  insert into public.timesheet_entries (user_id,employee_id,employee_name,work_date,project,details,category,start_time,end_time,break_hours,total_hours,overtime,billable,work_status,comments)
  values (employee.id,employee.employee_id,employee.name,p_work_date,trim(p_project),trim(p_details),trim(p_category),p_start_time,p_end_time,coalesce(p_break_hours,0),hours,greatest(0,hours-standard),coalesce(p_billable,false),coalesce(nullif(trim(p_work_status),''),'Completed'),coalesce(trim(p_comments),''))
  returning * into result;
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
  if trim(coalesce(p_project,''))='' or trim(coalesce(p_details,''))='' then raise exception 'Project and work details are required.'; end if;
  if p_work_date is null or p_start_time is null or p_end_time is null then raise exception 'Work date and times are required.'; end if;
  if p_end_time <= p_start_time then raise exception 'End time must be later than start time.'; end if;
  if coalesce(p_break_hours,0)<0 then raise exception 'Break hours cannot be negative.'; end if;
  if coalesce(p_break_hours,0) >= extract(epoch from (p_end_time-p_start_time))/3600 then raise exception 'Break hours must be shorter than the work period.'; end if;
  hours := public.calculate_work_hours(p_start_time,p_end_time,p_break_hours);
  select standard_hours into standard from public.app_settings where id;
  update public.timesheet_entries set work_date=p_work_date,project=trim(p_project),details=trim(p_details),category=trim(p_category),start_time=p_start_time,end_time=p_end_time,break_hours=coalesce(p_break_hours,0),total_hours=hours,overtime=greatest(0,hours-standard),billable=coalesce(p_billable,false),work_status=coalesce(nullif(trim(p_work_status),''),'Completed'),comments=coalesce(trim(p_comments),''),approval_status='Submitted',approval_comment='',approved_by='',approved_at=null where id=p_id returning * into result;
  return result;
end;
$$;

notify pgrst,'reload schema';
commit;
