-- Preserve working business transactions while rejecting a stale browser draft.
begin;
alter table public.crm_customer_records add column revision bigint not null default 0;
alter table public.crm_visits add column revision bigint not null default 0;
create function public.crm_increment_revision() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin new.revision:=old.revision+1; return new; end $$;
revoke all on function public.crm_increment_revision() from public,anon,authenticated,service_role;
create trigger crm_customer_revision before update on public.crm_customer_records for each row execute function public.crm_increment_revision();
create trigger crm_visit_revision before update on public.crm_visits for each row execute function public.crm_increment_revision();

alter function public.crm_update_customer(uuid,uuid,bigint,jsonb,boolean) rename to crm_update_customer_internal;
revoke all on function public.crm_update_customer_internal(uuid,uuid,bigint,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.crm_update_customer(p_actor uuid,p_store uuid,p_record bigint,p_changes jsonb,p_complete boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  -- Authorize before reporting revision conflicts, then hold the row lock until
  -- the underlying mutation AND its history insert have committed.
  select r.revision into current_revision from public.crm_customer_records r
    join public.crm_datasets d on d.id=r.dataset_id
    join public.profiles a on a.id=p_actor and a.active
    where r.id=p_record and d.store_id=p_store
      and (a.role='super_admin' or a.store_id=p_store)
      and (a.role in ('admin','super_admin') or d.owner_id=p_actor) for update of r;
  if not found then raise exception 'Customer not found' using errcode='42501'; end if;
  if coalesce(p_changes->>'expected_revision','') !~ '^[0-9]{1,18}$' then
    raise exception 'Reload the customer before saving' using errcode='PT428';
  end if;
  if (p_changes->>'expected_revision')::bigint<>current_revision then
    raise exception 'Customer changed since this form was loaded' using errcode='PT409';
  end if;
  return public.crm_update_customer_internal(p_actor,p_store,p_record,p_changes-'expected_revision',p_complete);
end $$;
revoke all on function public.crm_update_customer(uuid,uuid,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.crm_update_customer(uuid,uuid,bigint,jsonb,boolean) to service_role;

alter function public.crm_save_sales_visit(uuid,uuid,bigint,jsonb,jsonb,jsonb) rename to crm_save_sales_visit_internal;
revoke all on function public.crm_save_sales_visit_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.crm_save_sales_visit(p_actor uuid,p_store uuid,p_visit bigint,p_values jsonb,p_client jsonb,p_images jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  if p_visit is not null then
    select v.revision into current_revision from public.crm_visits v
      join public.profiles a on a.id=p_actor and a.active
      where v.id=p_visit and v.store_id=p_store
        and (a.role='super_admin' or a.store_id=p_store)
        and (a.role in ('admin','super_admin') or v.owner_id=p_actor) for update of v;
    if not found then raise exception 'Visit not found in your store' using errcode='42501'; end if;
    if coalesce(p_values->>'expected_revision','') !~ '^[0-9]{1,18}$' then
      raise exception 'Reload the visit before saving' using errcode='PT428';
    end if;
    if (p_values->>'expected_revision')::bigint<>current_revision then
      raise exception 'Visit changed since this form was loaded' using errcode='PT409';
    end if;
  end if;
  return public.crm_save_sales_visit_internal(p_actor,p_store,p_visit,p_values-'expected_revision',p_client,p_images);
end $$;
revoke all on function public.crm_save_sales_visit(uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.crm_save_sales_visit(uuid,uuid,bigint,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
