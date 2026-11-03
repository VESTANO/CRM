-- The user chose a web-only solution. No notifier was installed or paired.
-- Refuse cleanup if any real device data appeared in the meantime.
do $$
begin
  if exists(select 1 from public.crm_native_reminder_devices)
    or exists(select 1 from public.crm_native_reminder_receipts) then
    raise exception 'Native device data exists; refusing to remove it automatically';
  end if;
end $$;
drop table public.crm_native_reminder_receipts;
drop table public.crm_native_reminder_devices;
