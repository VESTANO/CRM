-- A visit may be recorded before a meeting time or location is known.
alter table public.crm_visits alter column meeting_time drop not null;
alter table public.crm_visits alter column location set default '';
