-- Uploads are private staging data. Only commit creates business records.
begin;
create table public.crm_import_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.crm_stores(id) on delete restrict,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  name text not null check (length(name) between 1 and 255),
  filename text not null check (length(filename) between 1 and 255),
  sheets jsonb not null,
  dataset_id bigint references public.crm_datasets(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  unique(owner_id,store_id,fingerprint)
);
create table public.crm_import_rows (
  job_id uuid not null references public.crm_import_jobs(id) on delete cascade,
  sheet_name text not null,
  row_number integer not null,
  original_data jsonb not null,
  primary key(job_id,sheet_name,row_number)
);
alter table public.crm_import_jobs enable row level security;
alter table public.crm_import_rows enable row level security;
revoke all on public.crm_import_jobs,public.crm_import_rows from public,anon,authenticated;
grant all on public.crm_import_jobs,public.crm_import_rows to service_role;
create index crm_import_expiry_idx on public.crm_import_jobs(expires_at) where dataset_id is null;

create function public.crm_import(p_actor uuid,p_store uuid,p_action text,p_job uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.crm_import_jobs; s jsonb; r jsonb; k text; n integer; expected integer:=0;
  dataset bigint; caller public.profiles; col_count integer;
begin
  select * into caller from public.profiles where id=p_actor and active;
  if not found or p_store is null or (caller.role<>'super_admin' and caller.store_id is distinct from p_store) then
    raise exception 'Import store is not accessible' using errcode='42501';
  end if;
  if p_action='start' then
    if coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$'
      or coalesce(length(trim(p_payload->>'datasetName')),0) not between 1 and 255
      or coalesce(length(p_payload->>'filename'),0) not between 1 and 255
      or jsonb_typeof(p_payload->'sheets') is distinct from 'array' then
      raise exception 'Invalid workbook metadata';
    end if;
    if jsonb_array_length(p_payload->'sheets') not between 1 and 50 then raise exception 'Use 1–50 sheets'; end if;
    for s in select value from jsonb_array_elements(p_payload->'sheets') loop
      if coalesce(length(s->>'name'),0) not between 1 and 255
        or jsonb_typeof(s->'column_names') is distinct from 'array'
        or jsonb_typeof(s->'field_keys') is distinct from 'array' then raise exception 'Invalid sheet layout'; end if;
      col_count:=jsonb_array_length(s->'field_keys');
      if col_count not between 1 and 500 or col_count<>jsonb_array_length(s->'column_names')
        or (s->>'expected_rows')::integer not between 0 and 100000
        or (s->>'rows')::integer < (s->>'expected_rows')::integer
        or (s->>'expected_rows') is null or (s->>'rows') is null then raise exception 'Invalid sheet counts'; end if;
      if (select count(distinct value) from jsonb_array_elements_text(s->'field_keys'))<>col_count then raise exception 'Duplicate column keys'; end if;
      for k in select value from jsonb_array_elements_text(s->'field_keys') loop
        if k is null or length(k) not between 1 and 255 then raise exception 'Invalid column key'; end if;
      end loop;
      for r in select value from jsonb_array_elements(s->'column_names') loop
        if jsonb_typeof(r)<>'string' or length(r#>>'{}') not between 1 and 255 then raise exception 'Invalid column heading'; end if;
      end loop;
      expected:=expected+(s->>'expected_rows')::integer;
    end loop;
    if expected not between 1 and 100000 or (select count(distinct value->>'name') from jsonb_array_elements(p_payload->'sheets'))<>jsonb_array_length(p_payload->'sheets') then raise exception 'Invalid workbook rows or repeated sheet names'; end if;
    insert into public.crm_import_jobs(owner_id,store_id,fingerprint,name,filename,sheets)
      values(p_actor,p_store,p_payload->>'fingerprint',trim(p_payload->>'datasetName'),p_payload->>'filename',p_payload->'sheets')
      on conflict(owner_id,store_id,fingerprint) do nothing;
    select * into j from public.crm_import_jobs where owner_id=p_actor and store_id=p_store and fingerprint=p_payload->>'fingerprint' for update;
    if j.dataset_id is not null then return jsonb_build_object('id',j.id,'dataset',jsonb_build_object('id',j.dataset_id),'reused',true); end if;
    if j.expires_at<now() then
      delete from public.crm_import_rows where job_id=j.id;
      update public.crm_import_jobs set sheets=p_payload->'sheets',name=trim(p_payload->>'datasetName'),expires_at=now()+interval '24 hours' where id=j.id returning * into j;
    end if;
    if j.sheets is distinct from p_payload->'sheets' then raise exception 'Workbook metadata changed; inspect the original file again'; end if;
    return jsonb_build_object('id',j.id);
  end if;
  select * into j from public.crm_import_jobs where id=p_job and owner_id=p_actor and store_id=p_store for update;
  if not found then raise exception 'Import not found' using errcode='42501'; end if;
  if j.dataset_id is not null then return jsonb_build_object('id',j.id,'dataset',jsonb_build_object('id',j.dataset_id),'reused',true); end if;
  if j.expires_at<now() then raise exception 'Import expired; inspect the workbook again'; end if;
  if p_action='batch' then
    if jsonb_typeof(p_payload->'rows') is distinct from 'array' then raise exception 'Send an array of rows'; end if;
    if jsonb_array_length(p_payload->'rows') not between 1 and 500 then raise exception 'Send 1–500 rows per batch'; end if;
    for r in select value from jsonb_array_elements(p_payload->'rows') loop
      select value into s from jsonb_array_elements(j.sheets) where value->>'name'=r->>'sheet_name';
      if not found or jsonb_typeof(r->'original_data') is distinct from 'object'
        or coalesce((r->>'row_number')::numeric,0)<>trunc(coalesce((r->>'row_number')::numeric,0))
        or coalesce((r->>'row_number')::integer,0) not between 2 and (s->>'rows')::integer+1 then
        raise exception 'Invalid customer row: sheet %, row %',r->>'sheet_name',r->>'row_number';
      end if;
      if exists(select 1 from jsonb_each(r->'original_data') v where not (s->'field_keys' ? v.key) or jsonb_typeof(v.value) not in ('string','number','boolean','null')) then
        raise exception 'Invalid customer fields: sheet %, row %',r->>'sheet_name',r->>'row_number';
      end if;
      if (select count(*) from jsonb_object_keys(r->'original_data'))<>jsonb_array_length(s->'field_keys')
        or not exists(select 1 from jsonb_each_text(r->'original_data') v where coalesce(v.value,'')<>'') then
        raise exception 'Missing or empty customer fields: sheet %, row %',r->>'sheet_name',r->>'row_number';
      end if;
      if exists(select 1 from public.crm_import_rows where job_id=j.id and sheet_name=r->>'sheet_name' and row_number=(r->>'row_number')::integer and original_data is distinct from r->'original_data') then
        raise exception 'Retry changed row % in sheet %',r->>'row_number',r->>'sheet_name';
      end if;
      insert into public.crm_import_rows values(j.id,r->>'sheet_name',(r->>'row_number')::integer,r->'original_data') on conflict do nothing;
    end loop;
    return jsonb_build_object('id',j.id,'staged',jsonb_array_length(p_payload->'rows'));
  elsif p_action='commit' then
    for s in select value from jsonb_array_elements(j.sheets) loop
      select count(*) into n from public.crm_import_rows where job_id=j.id and sheet_name=s->>'name';
      if n<>(s->>'expected_rows')::integer then raise exception 'Incomplete sheet %: expected %, received %',s->>'name',s->>'expected_rows',n; end if;
      expected:=expected+n;
    end loop;
    insert into public.crm_datasets(owner_id,store_id,name,original_filename) values(j.owner_id,j.store_id,j.name,j.filename) returning id into dataset;
    insert into public.crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order)
      select dataset,sheet->>'name',sheet->'column_names'->>(key.ordinality::integer-1),key.value,key.ordinality
      from jsonb_array_elements(j.sheets) sheet cross join lateral jsonb_array_elements_text(sheet->'field_keys') with ordinality key(value,ordinality);
    insert into public.crm_customer_records(dataset_id,sheet_name,row_number,original_data)
      select dataset,sheet_name,row_number,original_data from public.crm_import_rows where job_id=j.id;
    update public.crm_import_jobs set dataset_id=dataset where id=j.id;
    delete from public.crm_import_rows where job_id=j.id;
    return jsonb_build_object('id',j.id,'dataset',jsonb_build_object('id',dataset),'summary',jsonb_build_object('rows_imported',expected));
  end if;
  raise exception 'Unknown import action';
end $$;
revoke all on function public.crm_import(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.crm_import(uuid,uuid,text,uuid,jsonb) to service_role;

-- Expired abandoned uploads contain no business records. Schedule in staging
-- after validating the environment; completed deduplication receipts are kept.
create function public.crm_cleanup_imports() returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare affected bigint;
begin
  delete from public.crm_import_jobs where dataset_id is null and expires_at<now();
  get diagnostics affected=row_count;
  return affected;
end $$;
revoke all on function public.crm_cleanup_imports() from public,anon,authenticated;
grant execute on function public.crm_cleanup_imports() to service_role;
notify pgrst,'reload schema';
commit;
