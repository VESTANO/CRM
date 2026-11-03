create table public.crm_native_reminder_devices (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  pair_code text not null unique check(pair_code ~ '^[A-F0-9]{10}$'),
  requester_hash text not null,
  pair_expires_at timestamptz not null default now()+interval '10 minutes',
  owner_id uuid references auth.users(id) on delete cascade,
  approved_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check ((owner_id is null and approved_at is null) or (owner_id is not null and approved_at is not null))
);
create table public.crm_native_reminder_receipts (
  device_id uuid not null references public.crm_native_reminder_devices(id) on delete cascade,
  reminder_id bigint not null references public.crm_reminders(id) on delete cascade,
  delivery_revision bigint not null,
  displayed_at timestamptz not null default now(),
  primary key(device_id,reminder_id,delivery_revision)
);
alter table public.crm_native_reminder_devices enable row level security;
alter table public.crm_native_reminder_receipts enable row level security;
revoke all on public.crm_native_reminder_devices, public.crm_native_reminder_receipts from anon,authenticated;
grant all on public.crm_native_reminder_devices, public.crm_native_reminder_receipts to service_role;
create index crm_native_reminder_pair_rate_idx on public.crm_native_reminder_devices(requester_hash,created_at);
