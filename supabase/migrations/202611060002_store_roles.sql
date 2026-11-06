-- Multi-store tenancy is additive: existing CRM data remains in the original
-- Vestano CRM store and every current profile is attached to it.

create table if not exists public.crm_stores (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(trim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

insert into public.crm_stores (name)
values ('Vestano CRM')
on conflict (name) do nothing;

alter table public.profiles add column if not exists store_id uuid references public.crm_stores(id) on delete restrict;

update public.profiles
set store_id = (select id from public.crm_stores where name = 'Vestano CRM')
where store_id is null;

alter table public.profiles alter column store_id set not null;
create index if not exists crm_profiles_store_idx on public.profiles(store_id, employee_id);

-- ADMIN001 is the requested bootstrap Super Admin. If that account is not yet
-- present, this remains a safe no-op; no existing account is removed or reset.
update public.profiles set role = 'super_admin' where employee_id = 'ADMIN001';

alter table public.crm_stores enable row level security;
revoke all on public.crm_stores from anon, authenticated;
grant select, insert, update, delete on public.crm_stores to service_role;
