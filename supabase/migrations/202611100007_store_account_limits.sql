-- New stores can define the maximum number of active Admin and regular User
-- accounts that may access them. Null preserves unrestricted legacy stores.
begin;

alter table public.crm_stores
  add column if not exists admin_limit integer,
  add column if not exists user_limit integer;

alter table public.crm_stores
  drop constraint if exists crm_stores_admin_limit_nonnegative,
  add constraint crm_stores_admin_limit_nonnegative check (admin_limit is null or admin_limit >= 0);

alter table public.crm_stores
  drop constraint if exists crm_stores_user_limit_nonnegative,
  add constraint crm_stores_user_limit_nonnegative check (user_limit is null or user_limit >= 0);

commit;
