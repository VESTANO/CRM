-- A sales visit belongs to the employee who records it, rather than the owner
-- of the dataset that happened to contain the selected client.  The actor is
-- established from the authenticated Edge request, never from browser input.

create or replace function public.crm_save_sales_visit(p_actor uuid,p_store uuid,p_visit bigint,p_values jsonb,p_client jsonb,p_images jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare caller public.profiles; previous public.crm_visits; saved public.crm_visits;
  client_id bigint; linked_customer_id bigint; owner uuid; image jsonb; source public.crm_datasets;
  receipt_key uuid; input_fingerprint text; receipt public.crm_sales_visit_requests;
begin
  select * into caller from public.profiles where id=p_actor and active;
  if not found or p_store is null or (caller.role<>'super_admin' and caller.store_id is distinct from p_store) then
    raise exception 'Sales store is not accessible' using errcode='42501';
  end if;
  if p_visit is null and nullif(p_values->>'request_key','') is not null then
    receipt_key:=(p_values->>'request_key')::uuid;
    input_fingerprint:=encode(sha256(convert_to(jsonb_build_object('values',p_values-'request_key','client',p_client)::text,'UTF8')),'hex');
    perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':'||p_store::text||':'||receipt_key::text,0));
    select * into receipt from public.crm_sales_visit_requests r where r.actor_id=p_actor and r.store_id=p_store and r.request_key=receipt_key;
    if found then
      if receipt.request_fingerprint is distinct from input_fingerprint then raise exception 'This visit request was already saved with different values. Open a new visit form.' using errcode='23505'; end if;
      if receipt.visit_id is null then raise exception 'The previously created visit was deleted. Open a new visit form.'; end if;
      select * into saved from public.crm_visits where id=receipt.visit_id;
      return to_jsonb(saved)||jsonb_build_object('_replayed',true);
    end if;
  end if;
  if p_visit is not null then
    select * into previous from public.crm_visits where id=p_visit and store_id=p_store
      and (caller.role in ('admin','super_admin') or owner_id=p_actor) for update;
    if not found then raise exception 'Visit not found in your store' using errcode='42501'; end if;
  end if;
  if jsonb_typeof(p_values) is distinct from 'object' or jsonb_typeof(p_images) is distinct from 'array' or jsonb_array_length(p_images)>10 then raise exception 'Invalid visit payload'; end if;
  if coalesce(p_values->>'status','') not in ('healthy','follow_up_required','interested','not_interested','converted')
    or coalesce(p_values->>'payment_status','') not in ('not_paid','partially_paid','completed','one_time')
    or (p_values->>'visit_date') is null or coalesce(length(p_values->>'location'),0)>255
    or coalesce(length(p_values->>'note'),0)>2000 or coalesce(length(p_values->>'payment_description'),0)>2000 then raise exception 'Invalid visit details'; end if;
  if coalesce((p_values->>'expense')::numeric,-1) not between 0 and 99999999.99
    or coalesce((p_values->>'total_amount')::numeric,-1) not between 0 and 9999999999.99
    or coalesce((p_values->>'paid_amount')::numeric,-1) not between 0 and (p_values->>'total_amount')::numeric
    or (p_values->>'expense')::numeric<>round((p_values->>'expense')::numeric,2)
    or (p_values->>'total_amount')::numeric<>round((p_values->>'total_amount')::numeric,2)
    or (p_values->>'paid_amount')::numeric<>round((p_values->>'paid_amount')::numeric,2) then raise exception 'Invalid visit amounts'; end if;
  perform (p_values->>'visit_date')::date, nullif(p_values->>'meeting_time','')::time;
  if p_client is not null and p_client<>'null'::jsonb then
    if jsonb_typeof(p_client)<>'object' or coalesce(length(trim(p_client->>'client_name')),0) not between 1 and 255 then raise exception 'Invalid manual client'; end if;
    owner:=coalesce(previous.owner_id,p_actor);
    if previous.manual_client_id is not null then
      update public.crm_manual_clients set client_name=trim(p_client->>'client_name'),phone=coalesce(p_client->>'phone',''),email=coalesce(p_client->>'email',''),company=coalesce(p_client->>'company',''),location=coalesce(p_client->>'location','')
        where id=previous.manual_client_id and store_id=p_store returning id into client_id;
      if client_id is null then raise exception 'Manual client not found in your store' using errcode='42501'; end if;
    else
      insert into public.crm_manual_clients(owner_id,store_id,client_name,phone,email,company,location)
        values(owner,p_store,trim(p_client->>'client_name'),coalesce(p_client->>'phone',''),coalesce(p_client->>'email',''),coalesce(p_client->>'company',''),coalesce(p_client->>'location','')) returning id into client_id;
    end if;
  else
    linked_customer_id:=(p_values->>'customer_id')::bigint;
    select d.* into source from public.crm_datasets d join public.crm_customer_records r on r.dataset_id=d.id
      where r.id=linked_customer_id and d.store_id=p_store and (caller.role in ('admin','super_admin') or d.owner_id=p_actor);
    if not found then raise exception 'Customer not found in your store' using errcode='42501'; end if;
    -- New visits are attributed to the signed-in employee; edits retain the
    -- recorded employee to preserve an audit trail.
    owner:=coalesce(previous.owner_id,p_actor);
  end if;
  if p_visit is null then
    insert into public.crm_visits(owner_id,store_id,customer_id,manual_client_id,visit_date,meeting_time,location,expense,status,payment_status,total_amount,paid_amount,payment_description,note)
    values(owner,p_store,linked_customer_id,client_id,(p_values->>'visit_date')::date,nullif(p_values->>'meeting_time','')::time,coalesce(p_values->>'location',''),(p_values->>'expense')::numeric,p_values->>'status',p_values->>'payment_status',(p_values->>'total_amount')::numeric,(p_values->>'paid_amount')::numeric,coalesce(p_values->>'payment_description',''),coalesce(p_values->>'note','')) returning * into saved;
  else
    update public.crm_visits set customer_id=linked_customer_id,manual_client_id=client_id,visit_date=(p_values->>'visit_date')::date,meeting_time=nullif(p_values->>'meeting_time','')::time,location=coalesce(p_values->>'location',''),expense=(p_values->>'expense')::numeric,status=p_values->>'status',payment_status=p_values->>'payment_status',total_amount=(p_values->>'total_amount')::numeric,paid_amount=(p_values->>'paid_amount')::numeric,payment_description=coalesce(p_values->>'payment_description',''),note=coalesce(p_values->>'note','') where id=p_visit returning * into saved;
  end if;
  for image in select value from jsonb_array_elements(p_images) loop
    if coalesce(image->>'storage_path','') not like p_actor::text||'/%'
      or (nullif(image->>'thumbnail_path','') is not null and image->>'thumbnail_path' not like p_actor::text||'/%') then raise exception 'Invalid visit image path'; end if;
    insert into public.crm_visit_images(visit_id,storage_path,original_name,thumbnail_path,byte_size,thumbnail_byte_size,width,height)
      values(saved.id,image->>'storage_path',image->>'original_name',nullif(image->>'thumbnail_path',''),(image->>'byte_size')::integer,(image->>'thumbnail_byte_size')::integer,(image->>'width')::integer,(image->>'height')::integer);
  end loop;
  if receipt_key is not null then
    insert into public.crm_sales_visit_requests(actor_id,store_id,request_key,request_fingerprint,visit_id) values(p_actor,p_store,receipt_key,input_fingerprint,saved.id);
  end if;
  return to_jsonb(saved);
end $$;

revoke all on function public.crm_save_sales_visit(uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.crm_save_sales_visit(uuid,uuid,bigint,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
