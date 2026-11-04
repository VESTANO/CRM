-- Transactional integration coverage using existing active CRM identities.
-- Every fixture and RPC write is rolled back, including on successful runs.
begin;

do $$
declare employee uuid; administrator uuid; super_administrator uuid; other_user uuid;
begin
  select id into employee from public.profiles where active and role='employee' order by employee_id limit 1;
  select id into administrator from public.profiles where active and role='admin' order by employee_id limit 1;
  select id into super_administrator from public.profiles where active and role='super_admin' order by employee_id limit 1;
  administrator := coalesce(administrator,super_administrator);
  select id into other_user from public.profiles where active and id<>employee order by employee_id limit 1;
  if employee is null or administrator is null or super_administrator is null or other_user is null then
    raise exception 'Tests require active employee, administrator, super-admin, and another identity.';
  end if;
  perform set_config('test.employee_id',employee::text,true);
  perform set_config('test.admin_id',administrator::text,true);
  perform set_config('test.super_admin_id',super_administrator::text,true);
  perform set_config('test.other_id',other_user::text,true);
  perform set_config('test.own_punch_id',gen_random_uuid()::text,true);
  perform set_config('test.other_punch_id',gen_random_uuid()::text,true);
  perform set_config('test.other_entry_id',gen_random_uuid()::text,true);
  insert into public.attendance_records(id,user_id,punch_code,punched_at,serial_number)
  values
    (current_setting('test.own_punch_id')::uuid,employee,'integration-own',now(),'integration-test'),
    (current_setting('test.other_punch_id')::uuid,other_user,'integration-other',now(),'integration-test');
  insert into public.timesheet_entries(id,user_id,employee_id,employee_name,work_date,project,details,category,start_time,end_time,total_hours)
  select current_setting('test.other_entry_id')::uuid,id,employee_id,name,'2099-01-01',
    'Integration test','Must be invisible to employee','Project Work','09:30','17:30',8
  from public.profiles where id=other_user;
end;
$$;

select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.employee_id'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.employee_id'),true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;

do $$
declare entry public.timesheet_entries; disposable public.timesheet_entries;
begin
  if auth.uid()<>current_setting('test.employee_id')::uuid then raise exception 'Employee JWT simulation failed.'; end if;
  if (select count(*) from public.attendance_records where id=current_setting('test.own_punch_id')::uuid)<>1 then
    raise exception 'Employee cannot read their own attendance fixture.';
  end if;
  if exists(select 1 from public.attendance_records where user_id<>auth.uid() or user_id is null) then
    raise exception 'Employee can read another user or unmatched attendance.';
  end if;
  if exists(select 1 from public.timesheet_entries where user_id<>auth.uid()) then
    raise exception 'Employee can read another user timesheet.';
  end if;
  begin
    insert into public.attendance_records(punch_code,punched_at,serial_number) values('forbidden',now(),'integration-test');
    raise exception 'Employee can directly insert attendance.';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.timesheet_entries set approval_status='Approved' where id=current_setting('test.other_entry_id')::uuid;
    raise exception 'Employee can directly update timesheets.';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.review_timesheet_entry(current_setting('test.other_entry_id')::uuid,'Approved','forbidden');
    raise exception 'Employee can review timesheets.';
  exception when raise_exception then
    if sqlerrm<>'Only admins can approve entries.' then raise; end if;
  end;
  begin
    perform public.map_attendance_employee('integration-own',auth.uid());
    raise exception 'Employee can map attendance.';
  exception when raise_exception then
    if sqlerrm<>'Only admins can map attendance.' then raise; end if;
  end;

  entry := public.create_timesheet_entry('2099-01-01','Integration test','Create own entry','Project Work',
    '09:30','17:30',0.5,true,'Completed','fixture');
  if entry.user_id<>auth.uid() or entry.approval_status<>'Submitted' or entry.total_hours<>7.5 then
    raise exception 'Employee create RPC assigned incorrect ownership, status, or hours.';
  end if;
  perform set_config('test.own_entry_id',entry.id::text,true);
  entry := public.update_timesheet_entry(entry.id,'2099-01-01','Updated integration test','Update own entry','Meeting',
    '09:30','18:30',0.5,false,'Completed','updated');
  if entry.project<>'Updated integration test' or entry.total_hours<>8.5
    or entry.overtime<>greatest(0,8.5-(select standard_hours from public.app_settings where id)) then
    raise exception 'Employee update RPC did not calculate or save changes.';
  end if;
  disposable := public.create_timesheet_entry('2099-01-02','Disposable integration test','Delete own entry','Project Work',
    '09:30','17:30',0.5,false,'Completed','fixture');
  if not public.delete_timesheet_entry(disposable.id) then raise exception 'Employee delete RPC returned false.'; end if;
  if exists(select 1 from public.timesheet_entries where id=disposable.id) then raise exception 'Deleted entry is still present.'; end if;
  begin
    perform public.update_timesheet_entry(current_setting('test.other_entry_id')::uuid,'2099-01-01','Forbidden','Forbidden','Meeting',
      '09:30','17:30',0.5,false,'Completed','');
    raise exception 'Employee can edit someone else entry via RPC.';
  exception when raise_exception then
    if sqlerrm<>'This entry cannot be edited.' then raise; end if;
  end;
  begin
    perform public.delete_timesheet_entry(current_setting('test.other_entry_id')::uuid);
    raise exception 'Employee can delete someone else entry via RPC.';
  exception when raise_exception then
    if sqlerrm<>'This entry cannot be deleted.' then raise; end if;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.admin_id'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.admin_id'),true);
set local role authenticated;

do $$
declare reviewed public.timesheet_entries;
begin
  if not public.is_admin() then raise exception 'Administrator JWT simulation failed.'; end if;
  if not exists(select 1 from public.attendance_records where id=current_setting('test.own_punch_id')::uuid) then
    raise exception 'Administrator cannot read employee attendance.';
  end if;
  reviewed := public.review_timesheet_entry(current_setting('test.own_entry_id')::uuid,'Approved','Integration approval');
  if reviewed.approval_status<>'Approved' or reviewed.approved_at is null or reviewed.approved_by='' then
    raise exception 'Administrator review RPC did not persist approval metadata.';
  end if;
  begin
    update public.timesheet_entries set details='forbidden' where id=current_setting('test.own_entry_id')::uuid;
    raise exception 'Administrator can bypass RPCs and mutate employee data directly.';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.attendance_records(punch_code,punched_at,serial_number) values('forbidden-admin',now(),'integration-test');
    raise exception 'Administrator can directly forge attendance punches.';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.employee_id'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.employee_id'),true);
set local role authenticated;

do $$
begin
  begin
    perform public.update_timesheet_entry(current_setting('test.own_entry_id')::uuid,'2099-01-01','Forbidden','Approved entry','Meeting',
      '09:30','17:30',0.5,false,'Completed','');
    raise exception 'Employee can edit an approved entry.';
  exception when raise_exception then
    if sqlerrm<>'This entry cannot be edited.' then raise; end if;
  end;
  begin
    perform public.delete_timesheet_entry(current_setting('test.own_entry_id')::uuid);
    raise exception 'Employee can delete an approved entry.';
  exception when raise_exception then
    if sqlerrm<>'This entry cannot be deleted.' then raise; end if;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.super_admin_id'),'role','authenticated')::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.super_admin_id'),true);
set local role authenticated;

do $$
begin
  if public.current_user_role()<>'super_admin' then raise exception 'Super-admin JWT simulation failed.'; end if;
  if not public.delete_timesheet_entry(current_setting('test.own_entry_id')::uuid) then
    raise exception 'Super-admin cannot delete an approved entry.';
  end if;
  if exists(select 1 from public.timesheet_entries where id=current_setting('test.own_entry_id')::uuid) then
    raise exception 'Super-admin deletion did not remove the approved entry.';
  end if;
end;
$$;

reset role;
select 'PASS: employee isolation, RPC ownership, approval, and super-admin deletion' as integration_test;
rollback;
