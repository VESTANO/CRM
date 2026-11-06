-- Store membership belongs to each business record, independently of its creator.
-- Backfill from the existing owner; never transfer data between stores.
begin;
alter table public.crm_datasets add column store_id uuid references public.crm_stores(id) on delete restrict;
alter table public.crm_manual_clients add column store_id uuid references public.crm_stores(id) on delete restrict;
alter table public.crm_visits add column store_id uuid references public.crm_stores(id) on delete restrict;
alter table public.crm_reminders add column store_id uuid references public.crm_stores(id) on delete restrict;

update public.crm_datasets d set store_id=p.store_id from public.profiles p where p.id=d.owner_id;
update public.crm_manual_clients d set store_id=p.store_id from public.profiles p where p.id=d.owner_id;
update public.crm_visits d set store_id=p.store_id from public.profiles p where p.id=d.owner_id;
update public.crm_reminders d set store_id=p.store_id from public.profiles p where p.id=d.owner_id;

-- An unclassified business record fails this migration instead of being guessed
-- into Vestano or another store. Personal global reminders may remain unscoped.
alter table public.crm_datasets alter column store_id set not null;
alter table public.crm_manual_clients alter column store_id set not null;
alter table public.crm_visits alter column store_id set not null;
create index crm_datasets_store_idx on public.crm_datasets(store_id,uploaded_at);
create index crm_manual_clients_store_idx on public.crm_manual_clients(store_id);
create index crm_visits_store_idx on public.crm_visits(store_id,visit_date);
create index crm_reminders_store_idx on public.crm_reminders(store_id,owner_id);

create function public.crm_enforce_business_store() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare owner_store uuid; owner_role text;
begin
  select store_id,role into owner_store,owner_role from public.profiles where id=new.owner_id;
  if tg_op='UPDATE' and new.store_id is distinct from old.store_id then
    raise exception 'Existing records must stay in their original store.';
  end if;
  if new.store_id is null then new.store_id:=owner_store; end if;
  if new.store_id is null and tg_table_name<>'crm_reminders' then
    raise exception 'Select a store before creating business records.';
  end if;
  if owner_role is distinct from 'super_admin' and new.store_id is distinct from owner_store then
    raise exception 'The record owner must belong to the same store.';
  end if;
  return new;
end $$;
revoke all on function public.crm_enforce_business_store() from public,anon,authenticated;
create trigger crm_datasets_store_guard before insert or update on public.crm_datasets for each row execute function public.crm_enforce_business_store();
create trigger crm_manual_clients_store_guard before insert or update on public.crm_manual_clients for each row execute function public.crm_enforce_business_store();
create trigger crm_visits_store_guard before insert or update on public.crm_visits for each row execute function public.crm_enforce_business_store();
create trigger crm_reminders_store_guard before insert or update on public.crm_reminders for each row execute function public.crm_enforce_business_store();
notify pgrst,'reload schema';
commit;
