-- The shared update trigger writes updated_at, including when claiming,
-- rescheduling, retrying, and completing reminders.
alter table public.crm_reminders add column if not exists updated_at timestamptz not null default now();
