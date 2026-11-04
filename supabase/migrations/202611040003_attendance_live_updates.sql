-- Publish punches through the existing SELECT policies and support bounded
-- history/delta reads. No attendance permissions or policy predicates change.
begin;

alter table public.attendance_records
  add column if not exists updated_at timestamptz;

-- Historical rows must not look newly received when this migration is applied.
update public.attendance_records
set updated_at = created_at
where updated_at is null;

alter table public.attendance_records
  alter column updated_at set default clock_timestamp(),
  alter column updated_at set not null;

create or replace function public.attendance_records_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists attendance_records_set_updated_at on public.attendance_records;
create trigger attendance_records_set_updated_at
before update on public.attendance_records
for each row execute function public.attendance_records_set_updated_at();

create index if not exists attendance_records_date_id_idx
  on public.attendance_records(punched_at desc, id desc);
create index if not exists attendance_records_user_date_id_idx
  on public.attendance_records(user_id, punched_at desc, id desc);
create index if not exists attendance_records_updated_id_idx
  on public.attendance_records(updated_at, id);
create index if not exists attendance_records_user_updated_id_idx
  on public.attendance_records(user_id, updated_at, id);

do $$
declare
  attendance_table text;
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'The Supabase realtime publication is missing.';
  end if;
  foreach attendance_table in array array[
    'attendance_records', 'attendance_devices', 'attendance_mappings', 'profiles'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = attendance_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', attendance_table);
    end if;
  end loop;
end;
$$;

commit;
