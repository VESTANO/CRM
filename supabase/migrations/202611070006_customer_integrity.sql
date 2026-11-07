-- Keep customer CRM changes and their audit history in the same transaction.
-- The caller/store are trusted Edge arguments; browser roles cannot invoke it.
begin;
create function public.crm_update_customer(p_actor uuid,p_store uuid,p_record bigint,p_changes jsonb,p_complete boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare before_row public.crm_customer_records; after_row public.crm_customer_records;
  dataset public.crm_datasets; actor public.profiles; next_status text; next_note text; next_date date;
  previous_values jsonb; updated_values jsonb;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found or p_store is null or (actor.role<>'super_admin' and actor.store_id is distinct from p_store) then
    raise exception 'Customer store is not accessible' using errcode='42501';
  end if;
  select * into before_row from public.crm_customer_records where id=p_record for update;
  if not found then raise exception 'Customer not found' using errcode='P0002'; end if;
  select * into dataset from public.crm_datasets where id=before_row.dataset_id and store_id=p_store;
  if not found or (actor.role not in ('admin','super_admin') and dataset.owner_id<>p_actor) then
    raise exception 'Customer not found' using errcode='42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then raise exception 'Invalid CRM changes'; end if;
  next_status:=case when p_changes ? 'response' then trim(p_changes->>'response') else before_row.response end;
  if next_status is null or next_status not in ('no_response','interested','not_interested','callback','converted') then raise exception 'Choose a valid response status'; end if;
  next_note:=case when p_changes ? 'note' then coalesce(p_changes->>'note','') else before_row.note end;
  if p_changes ? 'callback_date' then
    if nullif(p_changes->>'callback_date','') is not null and (p_changes->>'callback_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Enter a valid callback date'; end if;
    next_date:=nullif(p_changes->>'callback_date','')::date;
  else next_date:=before_row.callback_date;
  end if;
  if p_complete then
    if before_row.response<>'callback' or before_row.callback_completed_at is not null then raise exception 'This callback is no longer pending' using errcode='40001'; end if;
    if next_status='callback' then raise exception 'Choose a final callback outcome'; end if;
    next_date:=before_row.callback_date;
  elsif next_status='callback' then
    if next_date is null then raise exception 'Choose a callback date'; end if;
  else next_date:=null;
  end if;
  update public.crm_customer_records set response=next_status,note=next_note,callback_date=next_date,
    callback_completed_at=case when p_complete then now() when next_status='callback' then null else before_row.callback_completed_at end,
    callback_completed_by=case when p_complete then p_actor when next_status='callback' then null else before_row.callback_completed_by end
    where id=p_record returning * into after_row;
  previous_values:=jsonb_build_object('response',before_row.response,'callback_date',coalesce(before_row.callback_date::text,''),'note',before_row.note);
  updated_values:=jsonb_build_object('response',after_row.response,'callback_date',coalesce(after_row.callback_date::text,''),'note',after_row.note);
  if previous_values is distinct from updated_values then
    insert into public.crm_customer_record_changes(record_id,changed_by,previous_values,updated_values)
      values(p_record,p_actor,previous_values,updated_values);
  end if;
  return to_jsonb(after_row);
end $$;
revoke all on function public.crm_update_customer(uuid,uuid,bigint,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.crm_update_customer(uuid,uuid,bigint,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
