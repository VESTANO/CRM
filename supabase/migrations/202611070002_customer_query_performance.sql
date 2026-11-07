begin;
create extension if not exists pg_trgm;
-- Pagination and aggregation stay next to the data. Dataset IDs are resolved
-- by the authorized Edge handler; these RPCs are never browser executable.
create function public.crm_dataset_counts(p_ids bigint[]) returns table(dataset_id bigint,customer_count bigint)
language sql stable security definer set search_path=public,pg_temp as $$
  select dataset_id,count(*) from public.crm_customer_records where dataset_id=any(p_ids) group by dataset_id
$$;
revoke all on function public.crm_dataset_counts(bigint[]) from public,anon,authenticated;
grant execute on function public.crm_dataset_counts(bigint[]) to service_role;

create function public.crm_record_name(p_data jsonb,p_row integer,p_dataset bigint,p_sheet text) returns text
language sql volatile set search_path=public,pg_temp as $$
  select coalesce(
    (select p_data->>k from unnest(array['customer_name','customer','client_name','client','full_name','name','contact_name','company_name','company']) with ordinality t(k,n) where nullif(p_data->>k,'') is not null order by n limit 1),
    (select p_data->>c.field_key from public.crm_dataset_columns c where c.dataset_id=p_dataset and c.sheet_name=p_sheet and nullif(p_data->>c.field_key,'') is not null order by c.column_order limit 1),
    (select value from jsonb_each_text(p_data) where nullif(value,'') is not null limit 1),
    'Customer row '||p_row)
$$;
revoke all on function public.crm_record_name(jsonb,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.crm_record_name(jsonb,integer,bigint,text) to service_role;

alter table public.crm_customer_records add column search_name text not null default '';
create function public.crm_refresh_record_name() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  new.search_name:=public.crm_record_name(new.original_data,new.row_number,new.dataset_id,new.sheet_name);
  return new;
end $$;
revoke all on function public.crm_refresh_record_name() from public,anon,authenticated;
create trigger crm_record_name before insert or update of original_data,dataset_id,sheet_name,row_number on public.crm_customer_records for each row execute function public.crm_refresh_record_name();
-- This derived-field backfill is not a customer edit. Preserve historical edit
-- times and callback ordering. Only the timestamp trigger is suspended; all
-- changes and re-enabling roll back together if any later statement fails.
alter table public.crm_customer_records disable trigger crm_customer_records_updated_at;
update public.crm_customer_records set search_name=public.crm_record_name(original_data,row_number,dataset_id,sheet_name);
alter table public.crm_customer_records enable trigger crm_customer_records_updated_at;
create function public.crm_refresh_column_names() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    update public.crm_customer_records set search_name=public.crm_record_name(original_data,row_number,dataset_id,sheet_name) where dataset_id=old.dataset_id and sheet_name=old.sheet_name;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.crm_customer_records set search_name=public.crm_record_name(original_data,row_number,dataset_id,sheet_name) where dataset_id=new.dataset_id and sheet_name=new.sheet_name;
  end if;
  return null;
end $$;
revoke all on function public.crm_refresh_column_names() from public,anon,authenticated;
create trigger crm_column_names after insert or update or delete on public.crm_dataset_columns for each row execute function public.crm_refresh_column_names();
create index crm_records_name_search_idx on public.crm_customer_records using gin(lower(search_name) gin_trgm_ops);

create function public.crm_customer_page(p_ids bigint[],p_query text,p_status text,p_page integer,p_size integer,p_mode text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; stats jsonb; total bigint; page integer; pages integer; pattern text;
begin
  if p_size not between 1 and 50 or p_mode not in ('customers','dataset') or length(coalesce(p_query,''))>500 then raise exception 'Invalid customer query'; end if;
  pattern:='%'||replace(replace(replace(lower(coalesce(p_query,'')),'!','!!'),'%','!%'),'_','!_')||'%';
  -- Materialize only identifiers/status for counting. Large original JSON rows
  -- are returned for the requested page only, never transferred to Edge in full.
  with matches as materialized (
    select r.id,r.response from public.crm_customer_records r where r.dataset_id=any(p_ids) and
    (coalesce(p_query,'')='' or
      (p_mode='customers' and lower(r.search_name) like pattern escape '!') or
      (p_mode='dataset' and (exists(select 1 from jsonb_each_text(r.original_data) v where strpos(lower(v.value),lower(p_query))>0)
        or strpos(lower(r.note),lower(p_query))>0
        or strpos(case r.response when 'no_response' then 'no response' when 'not_interested' then 'not interested' else r.response end,lower(p_query))>0)))
  ) select count(*) filter(where coalesce(p_status,'')='' or response=p_status) into total from matches;
  if p_mode='dataset' then
    select coalesce(jsonb_object_agg(response,n),'{}') into stats from (select response,count(*) n from public.crm_customer_records where dataset_id=any(p_ids) group by response) c;
  else
    select coalesce(jsonb_object_agg(response,n),'{}') into stats from (select r.response,count(*) n from public.crm_customer_records r where r.dataset_id=any(p_ids) and
      (coalesce(p_query,'')='' or lower(r.search_name) like pattern escape '!') group by r.response) c;
  end if;
  pages:=greatest(1,ceil(total::numeric/p_size)::integer); page:=least(greatest(1,coalesce(p_page,1)),pages);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into result from (
    select r.* from public.crm_customer_records r where r.dataset_id=any(p_ids) and (coalesce(p_status,'')='' or r.response=p_status) and
    (coalesce(p_query,'')='' or
      (p_mode='customers' and lower(r.search_name) like pattern escape '!') or
      (p_mode='dataset' and (exists(select 1 from jsonb_each_text(r.original_data) v where strpos(lower(v.value),lower(p_query))>0)
        or strpos(lower(r.note),lower(p_query))>0
        or strpos(case r.response when 'no_response' then 'no response' when 'not_interested' then 'not interested' else r.response end,lower(p_query))>0)))
    order by r.dataset_id,r.sheet_name,r.row_number,r.id limit p_size offset (page-1)*p_size
  ) t;
  return jsonb_build_object('records',result,'stats',stats,'count',total,'page',page,'numPages',pages);
end $$;
revoke all on function public.crm_customer_page(bigint[],text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.crm_customer_page(bigint[],text,text,integer,integer,text) to service_role;
create index if not exists crm_records_page_idx on public.crm_customer_records(dataset_id,sheet_name,row_number,id);
notify pgrst,'reload schema';
commit;
