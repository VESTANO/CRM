-- Send timesheet changes to connected employee, admin, and super-admin
-- workspaces. Realtime still respects the existing table SELECT policies.
begin;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'timesheet_entries'
  ) then
    alter publication supabase_realtime add table public.timesheet_entries;
  end if;
end;
$$;

commit;
