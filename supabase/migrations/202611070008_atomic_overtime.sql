begin;
-- Request/decision and their durable alerts commit together. The database
-- checks the current final punch pair under the same transaction as approval.
create function public.crm_write_overtime(p_actor uuid,p_store uuid,p_id bigint,p_action text,p_values jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; employee public.profiles; item public.crm_overtime_requests;
  work_day date; cutoff timestamptz; punch_out timestamptz; punches bigint; leaving timestamptz; reason text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found or p_store is null or (actor.role<>'super_admin' and actor.store_id is distinct from p_store) then
    raise exception 'Overtime store is not accessible.' using errcode='42501';
  end if;
  if p_id is null then
    if p_action is distinct from 'create' then raise exception 'Unknown overtime action.' using errcode='22023'; end if;
    -- A global account can review a selected store, but its own attendance has
    -- no store membership and must not create a request that no store can list.
    if actor.store_id is distinct from p_store then
      raise exception 'A store employee account is required to request overtime.' using errcode='42501';
    end if;
    employee:=actor;
    work_day:=(p_values->>'workDate')::date;
    leaving:=(p_values->>'declaredLeaveTime')::timestamptz;
    if work_day is null or leaving is null or (leaving at time zone 'Asia/Kolkata')::date<>work_day then
      raise exception 'Expected leaving time must be on the selected working date.' using errcode='22023';
    end if;
    cutoff:=(work_day+coalesce(employee.shift_end_time,'17:30'::time)+interval '5 minutes') at time zone 'Asia/Kolkata';
    if leaving<=cutoff then raise exception 'Expected leaving time must be after the official end time.' using errcode='22023'; end if;
  else
    if actor.role not in ('admin','super_admin') then raise exception 'Administrator access required.' using errcode='42501'; end if;
    select * into item from public.crm_overtime_requests where id=p_id for update;
    if not found then raise exception 'OT request not found.' using errcode='P0002'; end if;
    select * into employee from public.profiles where id=item.employee_id;
    if not found or employee.store_id is distinct from p_store then raise exception 'OT request not found in your store.' using errcode='42501'; end if;
    if item.status<>'pending' then raise exception 'This OT request has already been reviewed.' using errcode='P0001'; end if;
    if p_action is null or p_action not in ('approve','reject') then raise exception 'Unknown review action.' using errcode='22023'; end if;
    reason:=trim(coalesce(p_values->>'message',''));
    if p_action='reject' and reason='' then raise exception 'Enter a rejection reason.' using errcode='22023'; end if;
    work_day:=item.work_date;
    cutoff:=(work_day+item.assigned_end_time+interval '5 minutes') at time zone 'Asia/Kolkata';
  end if;
  select count(*),max(punched_at) into punches,punch_out from public.attendance_records
    where user_id=employee.id and punched_at>=(work_day::timestamp at time zone 'Asia/Kolkata')
      and punched_at<((work_day+1)::timestamp at time zone 'Asia/Kolkata');
  if punches<2 or punches%2<>0 or punch_out<=cutoff then punch_out:=null; end if;
  if p_id is null then
    insert into public.crm_overtime_requests(employee_id,work_date,assigned_start_time,assigned_end_time,official_end_time,declared_leave_time,actual_punch_out,requested_minutes)
      values(employee.id,work_day,coalesce(employee.shift_start_time,'09:30'::time),coalesce(employee.shift_end_time,'17:30'::time),
        (cutoff at time zone 'Asia/Kolkata')::time,leaving,punch_out,floor(extract(epoch from leaving-cutoff)/60)::integer) returning * into item;
    insert into public.crm_reminders(owner_id,store_id,text,reminder_at)
      select id,p_store,left('New OT request from '||coalesce(nullif(employee.name,''),employee.employee_id)||' for '||work_day,500),now()
      from public.profiles where active and role in ('admin','super_admin') and (role='super_admin' or store_id=p_store);
  else
    if p_action='approve' and punch_out is null then raise exception 'Approval requires a final punch-out record.' using errcode='22023'; end if;
    update public.crm_overtime_requests set status=case when p_action='approve' then 'approved' else 'rejected' end,
      actual_punch_out=punch_out,approved_minutes=case when p_action='approve' then floor(extract(epoch from punch_out-cutoff)/60)::integer else 0 end,
      rejection_message=case when p_action='reject' then reason else '' end,reviewed_by=p_actor,reviewed_at=now()
      where id=item.id returning * into item;
    insert into public.crm_reminders(owner_id,store_id,text,reminder_at) values(employee.id,p_store,
      left('Your OT request for '||work_day||' was '||item.status||'.'||case when reason<>'' then ' '||reason else '' end,500),now());
  end if;
  return to_jsonb(item);
end $$;
revoke all on function public.crm_write_overtime(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_write_overtime(uuid,uuid,bigint,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
