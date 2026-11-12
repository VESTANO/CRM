begin;

-- Approval comments are optional in every review flow. Keep a dedicated
-- field for decisions so payroll instructions and review feedback are never
-- mixed together.
alter table if exists public.crm_overtime_requests
  add column if not exists review_note text not null default '';
alter table if exists public.crm_overtime_requests
  drop constraint if exists crm_overtime_requests_review_note_length,
  add constraint crm_overtime_requests_review_note_length check (char_length(review_note) <= 4000);

alter table if exists public.crm_payroll_payments
  add column if not exists review_note text not null default '';
alter table if exists public.crm_payroll_payments
  drop constraint if exists crm_payroll_payments_review_note_length,
  add constraint crm_payroll_payments_review_note_length check (char_length(review_note) <= 4000);

-- The public task-review wrapper performs store access checks. Its internal
-- worker only validates a real review action and safely stores a blank note
-- when the reviewer leaves the optional field empty.
create or replace function public.crm_review_task_submission_internal(
  p_task_id bigint, p_submission_id bigint, p_actor uuid, p_action text, p_note text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare task public.crm_assigned_tasks%rowtype; latest_id bigint;
begin
  if not exists (select 1 from public.profiles where id = p_actor and active and role in ('admin', 'super_admin')) then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'Choose Approve or Reject.' using errcode = '22023';
  end if;
  select * into task from public.crm_assigned_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  select max(id) into latest_id from public.crm_task_submissions where task_id = task.id;
  if task.status <> 'submitted' or p_submission_id is distinct from latest_id then
    raise exception 'This submission has changed or has already been reviewed. Load the latest task.' using errcode = '40001';
  end if;
  update public.crm_task_submissions set
    status = case when p_action = 'approve' then 'approved' else 'rejected' end,
    review_note = left(trim(coalesce(p_note, '')), 4000), reviewed_by = p_actor, reviewed_at = now()
  where id = p_submission_id and task_id = task.id;
  update public.crm_assigned_tasks set
    status = case when p_action = 'approve' then 'done' else 'rejected' end,
    completed_at = case when p_action = 'approve' then now() else null end
  where id = task.id returning * into task;
  return to_jsonb(task);
end;
$$;

create or replace function public.review_timesheet_entry(p_id uuid,p_approval_status text,p_approval_comment text)
returns public.timesheet_entries language plpgsql security definer set search_path=public,pg_temp as $$
declare reviewer public.profiles; result public.timesheet_entries;
begin
  select * into reviewer from public.profiles where id=auth.uid() and active and role in ('super_admin','admin');
  if reviewer.id is null then raise exception 'Only admins can approve entries.' using errcode='42501'; end if;
  if p_approval_status is null or p_approval_status not in ('Approved','Rejected') then
    raise exception 'Choose Approved or Rejected.' using errcode='22023';
  end if;
  select * into result from public.timesheet_entries where id=p_id and public.can_view_store_member(user_id) for update;
  if result.id is null then raise exception 'Timesheet entry not found in your store.' using errcode='P0002'; end if;
  if result.approval_status<>'Submitted' then
    raise exception 'This timesheet submission has already been reviewed. Refresh the approval queue.' using errcode='P0001';
  end if;
  update public.timesheet_entries set approval_status=p_approval_status,
    approval_comment=left(trim(coalesce(p_approval_comment,'')),4000),approved_by=reviewer.name,approved_at=now()
  where id=p_id returning * into result;
  return result;
end $$;
revoke all on function public.review_timesheet_entry(uuid,text,text) from public,anon;
grant execute on function public.review_timesheet_entry(uuid,text,text) to authenticated,service_role;

create or replace function public.crm_write_overtime(p_actor uuid,p_store uuid,p_id bigint,p_action text,p_values jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; employee public.profiles; item public.crm_overtime_requests;
  work_day date; cutoff timestamptz; punch_out timestamptz; punches bigint; leaving timestamptz; note text;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found or p_store is null or (actor.role<>'super_admin' and actor.store_id is distinct from p_store) then
    raise exception 'Overtime store is not accessible.' using errcode='42501';
  end if;
  if p_id is null then
    if p_action is distinct from 'create' then raise exception 'Unknown overtime action.' using errcode='22023'; end if;
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
    note:=left(trim(coalesce(p_values->>'note',p_values->>'message','')),4000);
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
      review_note=note,rejection_message=case when p_action='reject' then note else '' end,reviewed_by=p_actor,reviewed_at=now()
      where id=item.id returning * into item;
    insert into public.crm_reminders(owner_id,store_id,text,reminder_at) values(employee.id,p_store,
      left('Your OT request for '||work_day||' was '||item.status||'.'||case when note<>'' then ' '||note else '' end,500),now());
  end if;
  return to_jsonb(item);
end $$;
revoke all on function public.crm_write_overtime(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_write_overtime(uuid,uuid,bigint,text,jsonb) to service_role;

notify pgrst,'reload schema';
commit;
