-- Throttle public password-reset requests without storing an email address.
create table if not exists public.crm_password_reset_requests (
  email_hash text primary key check (char_length(email_hash) = 64),
  requested_at timestamptz not null default now()
);

alter table public.crm_password_reset_requests enable row level security;
revoke all on public.crm_password_reset_requests from public, anon, authenticated;
grant select, insert, update on public.crm_password_reset_requests to service_role;
