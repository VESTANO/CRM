-- Sales is the standard designation used for target eligibility. Seed every
-- store and ensure future stores receive it automatically.
begin;

insert into public.crm_designations (store_id, name)
select id, 'Sales'
from public.crm_stores
on conflict do nothing;

create or replace function public.crm_seed_store_designations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.crm_designations (store_id, name)
  values (new.id, 'Sales')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists crm_stores_seed_designations on public.crm_stores;
create trigger crm_stores_seed_designations
  after insert on public.crm_stores
  for each row execute function public.crm_seed_store_designations();

revoke all on function public.crm_seed_store_designations() from public, anon, authenticated;
grant execute on function public.crm_seed_store_designations() to service_role;

commit;
