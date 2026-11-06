-- Super Admins are global accounts. They are never members of a store and
-- therefore cannot inherit or be counted as part of a store's data.

alter table public.profiles alter column store_id drop not null;

update public.profiles
set store_id = null
where role = 'super_admin';

-- Non-super-admin accounts must continue to belong to exactly one store.
alter table public.profiles
  add constraint profiles_store_required_for_store_roles
  check (role = 'super_admin' or store_id is not null);
