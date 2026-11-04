-- Record the operational delivery route while retiring the legacy receiver.
-- This marker describes the request path; it is not an authentication control.
begin;

alter table public.attendance_devices
  add column if not exists last_ingest_route text
    check (last_ingest_route in ('direct', 'legacy-proxy'));

comment on column public.attendance_devices.last_ingest_route is
  'Delivery path of the latest supported request: direct or legacy-proxy. Operational diagnostic only; not authentication evidence.';

commit;
