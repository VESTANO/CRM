-- Private staging for the authorized one-time migration from the local Django CRM.
-- Passwords remain one-way Django hashes until the user successfully signs in.

create table if not exists public.crm_legacy_auth (
  local_user_id bigint primary key,
  username text not null unique,
  original_email text not null default '',
  auth_email text not null unique,
  password_hash text,
  is_active boolean not null default true,
  role text not null check (role in ('super_admin', 'admin', 'manager', 'employee')),
  name text not null,
  first_name text not null default '',
  last_name text not null default '',
  date_joined timestamptz not null default now(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  password_upgraded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_migration_authorizations (
  token_hash text primary key check (char_length(token_hash) = 64),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.crm_legacy_auth enable row level security;
alter table public.crm_migration_authorizations enable row level security;

revoke all on public.crm_legacy_auth, public.crm_migration_authorizations from anon, authenticated;
grant all on public.crm_legacy_auth, public.crm_migration_authorizations to service_role;

create or replace function public.crm_reset_identity_sequences()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  table_name text;
  sequence_name text;
  last_id bigint;
begin
  foreach table_name in array array[
    'crm_datasets', 'crm_dataset_columns', 'crm_customer_records',
    'crm_customer_record_changes', 'crm_manual_clients', 'crm_visits',
    'crm_visit_images', 'crm_reminders', 'crm_assigned_tasks',
    'crm_sales_targets', 'crm_overtime_requests', 'crm_push_subscriptions',
    'crm_reminder_deliveries'
  ] loop
    sequence_name := pg_get_serial_sequence(format('public.%I', table_name), 'id');
    execute format('select max(id) from public.%I', table_name) into last_id;
    if sequence_name is not null then
      perform setval(sequence_name, coalesce(last_id, 1), last_id is not null);
    end if;
  end loop;
end;
$$;

revoke all on function public.crm_reset_identity_sequences() from public, anon, authenticated;
grant execute on function public.crm_reset_identity_sequences() to service_role;
