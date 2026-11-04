-- Integration coverage for live attendance. All fixture writes are rolled back;
-- no test punch is committed or emitted through the realtime publication.
begin;

do $$
declare
  employee uuid;
  other_employee uuid;
  administrator uuid;
  fixture_id uuid := gen_random_uuid();
  other_fixture_id uuid := gen_random_uuid();
  default_timestamp timestamptz;
  updated_timestamp timestamptz;
  started_at timestamptz := clock_timestamp();
  attendance_table text;
begin
  select id into employee from public.profiles
    where active and role = 'employee' order by employee_id limit 1;
  select id into other_employee from public.profiles
    where active and role = 'employee' and id <> employee order by employee_id limit 1;
  select id into administrator from public.profiles
    where active and role in ('super_admin', 'admin') order by employee_id limit 1;
  if employee is null or other_employee is null or administrator is null then
    raise exception 'Tests require two active employees and an active administrator.';
  end if;

  if (select count(*) from pg_indexes
      where schemaname = 'public'
        and tablename = 'attendance_records'
        and indexname in (
          'attendance_records_date_id_idx', 'attendance_records_user_date_id_idx',
          'attendance_records_updated_id_idx', 'attendance_records_user_updated_id_idx'
        )) <> 4 then
    raise exception 'Attendance history/delta cursor indexes are missing.';
  end if;
  foreach attendance_table in array array[
    'attendance_records', 'attendance_devices', 'attendance_mappings', 'profiles'
  ] loop
    if not exists (select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename = attendance_table) then
      raise exception 'Attendance realtime publication is missing %.', attendance_table;
    end if;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', attendance_table)::regclass) then
      raise exception 'RLS is disabled for %.', attendance_table;
    end if;
  end loop;

  if has_table_privilege('anon', 'public.attendance_records', 'SELECT')
    or not has_table_privilege('authenticated', 'public.attendance_records', 'SELECT')
    or has_table_privilege('authenticated', 'public.attendance_records', 'INSERT')
    or has_table_privilege('authenticated', 'public.attendance_records', 'UPDATE')
    or has_table_privilege('authenticated', 'public.attendance_records', 'DELETE') then
    raise exception 'Attendance direct table grants changed.';
  end if;
  if exists (select 1 from public.attendance_records where updated_at is null) then
    raise exception 'Existing punches have no live-update cursor.';
  end if;

  perform set_config('test.live_employee_id', employee::text, true);
  perform set_config('test.live_admin_id', administrator::text, true);
  perform set_config('test.live_punch_id', fixture_id::text, true);
  perform set_config('test.live_other_punch_id', other_fixture_id::text, true);
  insert into public.attendance_records(id, user_id, punch_code, punched_at, serial_number, created_at)
    values (fixture_id, employee, fixture_id::text, now(), 'live-updates-test', '2000-01-01')
    returning updated_at into default_timestamp;
  if default_timestamp < started_at or default_timestamp > clock_timestamp() then
    raise exception 'New punches do not receive a server-time updated_at default.';
  end if;
  update public.attendance_records
    set status = 'trigger-test', updated_at = '2000-01-01'
    where id = fixture_id returning updated_at into updated_timestamp;
  if updated_timestamp < default_timestamp or updated_timestamp > clock_timestamp() then
    raise exception 'Punch update trigger did not assign the current server timestamp.';
  end if;
  insert into public.attendance_records(id, user_id, punch_code, punched_at, serial_number)
    values (other_fixture_id, other_employee, other_fixture_id::text, now(), 'live-updates-test');
end;
$$;

select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.live_employee_id'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', current_setting('test.live_employee_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $$
begin
  if auth.uid() <> current_setting('test.live_employee_id')::uuid then
    raise exception 'Employee JWT simulation failed.';
  end if;
  if (select count(*) from public.attendance_records
      where id = current_setting('test.live_punch_id')::uuid and updated_at is not null) <> 1 then
    raise exception 'Employee cannot read their own punch and update cursor.';
  end if;
  if exists (select 1 from public.attendance_records where user_id is distinct from auth.uid()) then
    raise exception 'Employee can read another employee or unmatched punches.';
  end if;
  begin
    update public.attendance_records set status = 'forbidden'
      where id = current_setting('test.live_punch_id')::uuid;
    raise exception 'Employee can directly update a punch.';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.attendance_records where id = current_setting('test.live_punch_id')::uuid;
    raise exception 'Employee can directly delete a punch.';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('test.live_admin_id'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', current_setting('test.live_admin_id'), true);
set local role authenticated;

do $$
begin
  if not public.is_admin() then raise exception 'Administrator JWT simulation failed.'; end if;
  if (select count(*) from public.attendance_records where id in (
      current_setting('test.live_punch_id')::uuid, current_setting('test.live_other_punch_id')::uuid
    )) <> 2 then
    raise exception 'Administrator cannot read all employee punch fixtures.';
  end if;
  begin
    insert into public.attendance_records(punch_code, punched_at, serial_number)
      values ('forbidden-admin', now(), 'live-updates-test');
    raise exception 'Administrator can directly create a punch.';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select 'PASS: attendance cursors, update trigger, realtime publication, employee isolation and table grants' as integration_test;
rollback;
