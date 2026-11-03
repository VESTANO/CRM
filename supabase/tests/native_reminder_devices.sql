begin;
do $$
begin
  if has_table_privilege('anon','public.crm_native_reminder_devices','select')
    or has_table_privilege('authenticated','public.crm_native_reminder_devices','update')
    or has_table_privilege('authenticated','public.crm_native_reminder_receipts','select') then
    raise exception 'Native device capabilities are exposed to ordinary database clients';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.crm_native_reminder_devices'::regclass) then
    raise exception 'Native device RLS is disabled';
  end if;
end $$;
select true as native_device_permissions_passed;
rollback;
