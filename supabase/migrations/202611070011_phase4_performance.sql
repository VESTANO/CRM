begin;
-- Match the actual sales-page ordering and per-customer audit navigation.
create index crm_visits_store_page_idx on public.crm_visits(store_id,visit_date desc,meeting_time desc,created_at desc,id desc);
create index crm_customer_history_page_idx on public.crm_customer_record_changes(record_id,changed_at desc,id desc);

create function public.crm_sales_visit_page(p_store uuid,p_owner uuid,p_filters jsonb,p_page integer)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare total bigint; page integer; pages integer; items jsonb;
  q text:=lower(trim(coalesce(p_filters->>'q',''))); dataset_q text:=lower(trim(coalesce(p_filters->>'dataset_name','')));
  status_q text:=coalesce(p_filters->>'status',''); payment_q text:=coalesce(p_filters->>'payment_status','');
  first_day date:=nullif(p_filters->>'date_from','')::date; last_day date:=nullif(p_filters->>'date_to','')::date;
begin
  if length(q)>500 or length(dataset_q)>500 or coalesce(p_page,1)<1 or p_page>1000000 then raise exception 'Invalid sales query'; end if;
  if status_q<>'' and status_q not in ('healthy','follow_up_required','interested','not_interested','converted') then raise exception 'Invalid visit status'; end if;
  if payment_q<>'' and payment_q not in ('not_paid','partially_paid','completed','one_time') then raise exception 'Invalid payment status'; end if;
  select count(*) into total from public.crm_visits v
    left join public.crm_customer_records r on r.id=v.customer_id
    left join public.crm_datasets d on d.id=r.dataset_id
    left join public.crm_manual_clients m on m.id=v.manual_client_id
    where v.store_id=p_store and (p_owner is null or v.owner_id=p_owner)
      and (status_q='' or v.status=status_q) and (payment_q='' or (v.status='converted' and v.payment_status=payment_q))
      and (first_day is null or v.visit_date>=first_day) and (last_day is null or v.visit_date<=last_day)
      and (q='' or strpos(lower(coalesce(r.search_name,m.client_name,'')),q)>0)
      and (dataset_q='' or strpos(lower(coalesce(d.name,'')),dataset_q)>0);
  pages:=greatest(1,ceil(total::numeric/5)::integer);page:=least(greatest(1,coalesce(p_page,1)),pages);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into items from (
    select v.* from public.crm_visits v
      left join public.crm_customer_records r on r.id=v.customer_id
      left join public.crm_datasets d on d.id=r.dataset_id
      left join public.crm_manual_clients m on m.id=v.manual_client_id
      where v.store_id=p_store and (p_owner is null or v.owner_id=p_owner)
        and (status_q='' or v.status=status_q) and (payment_q='' or (v.status='converted' and v.payment_status=payment_q))
        and (first_day is null or v.visit_date>=first_day) and (last_day is null or v.visit_date<=last_day)
        and (q='' or strpos(lower(coalesce(r.search_name,m.client_name,'')),q)>0)
        and (dataset_q='' or strpos(lower(coalesce(d.name,'')),dataset_q)>0)
      order by v.visit_date desc,v.meeting_time desc,v.created_at desc,v.id desc limit 5 offset (page-1)*5
  ) t;
  return jsonb_build_object('records',items,'pagination',jsonb_build_object('page',page,'pageSize',5,'count',total,'numPages',pages));
end $$;
revoke all on function public.crm_sales_visit_page(uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.crm_sales_visit_page(uuid,uuid,jsonb,integer) to service_role;

create function public.crm_customer_history_page(p_record bigint,p_before_time timestamptz,p_before_id bigint)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with history_window as materialized (
    select * from public.crm_customer_record_changes where record_id=p_record
      and (p_before_time is null or (changed_at,id)<(p_before_time,p_before_id))
    order by changed_at desc,id desc limit 51
  ), visible as (select * from history_window order by changed_at desc,id desc limit 50)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(v) order by v.changed_at desc,v.id desc) from visible v),'[]'),
    'nextCursor',case when (select count(*) from history_window)>50 then
      (select jsonb_build_object('time',changed_at,'id',id) from visible order by changed_at asc,id asc limit 1) else null end)
$$;
revoke all on function public.crm_customer_history_page(bigint,timestamptz,bigint) from public,anon,authenticated;
grant execute on function public.crm_customer_history_page(bigint,timestamptz,bigint) to service_role;

create function public.crm_sales_client_page(p_dataset bigint,p_query text,p_page integer,p_selected bigint)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare items jsonb; selected_row jsonb; more boolean; q text:=lower(trim(coalesce(p_query,'')));
begin
  if length(q)>500 or coalesce(p_page,1)<1 or p_page>1000000 then raise exception 'Invalid client query'; end if;
  with matches as materialized (
    select id,sheet_name,row_number,search_name from public.crm_customer_records r where dataset_id=p_dataset
      and (q='' or strpos(lower(array_to_string(array(select value from jsonb_each_text(r.original_data)),' ')),q)>0)
    order by sheet_name,row_number,id limit 51 offset (coalesce(p_page,1)-1)*50
  ) select coalesce(jsonb_agg(to_jsonb(v) order by n) filter(where n<=50),'[]'),count(*)>50 into items,more
    from (select *,row_number() over(order by sheet_name,row_number,id) n from matches) v;
  if coalesce(p_page,1)=1 and p_selected is not null then
    select to_jsonb(r) into selected_row from (select id,sheet_name,row_number,search_name from public.crm_customer_records where dataset_id=p_dataset and id=p_selected) r;
  end if;
  return jsonb_build_object('records',items,'selected',selected_row,'pagination',jsonb_build_object('page',coalesce(p_page,1),'hasMore',more));
end $$;
revoke all on function public.crm_sales_client_page(bigint,text,integer,bigint) from public,anon,authenticated;
grant execute on function public.crm_sales_client_page(bigint,text,integer,bigint) to service_role;

-- Aggregate the base table once. Building six months previously rescanned the
-- materialized visit history for every month as well as all-time totals.
create or replace function public.crm_sales_report(p_store uuid,p_owner uuid,p_today date) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with grouped as materialized (
    select date_trunc('month',visit_date)::date period_start,status,count(*) n,sum(expense) expense
    from public.crm_visits where store_id=p_store and (p_owner is null or owner_id=p_owner)
    group by 1,status
  ), statuses as (
    select status,sum(n) n from grouped group by status
  ), month_counts as (
    select period_start,sum(n) n from grouped group by period_start
  ), months as (
    select (date_trunc('month',p_today)::date-(g||' months')::interval)::date period_start from generate_series(5,0,-1) g
  ) select jsonb_build_object(
    'totalVisits',(select coalesce(sum(n),0) from grouped),
    'totalExpenses',(select coalesce(sum(expense),0) from grouped),
    'activeMonths',(select count(*) from month_counts),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('value',status,'label',case status when 'healthy' then 'Healthy' when 'follow_up_required' then 'Follow-up Required' when 'interested' then 'Interested' when 'not_interested' then 'Not Interested' when 'converted' then 'Converted' else status end,'count',n) order by status),'[]'::jsonb) from statuses),
    'recentMonths',(select jsonb_agg(jsonb_build_object('key',to_char(m.period_start,'YYYY-MM'),'label',to_char(m.period_start,'Mon'),'count',coalesce(c.n,0)) order by m.period_start) from months m left join month_counts c using(period_start))
  )
$$;
revoke all on function public.crm_sales_report(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.crm_sales_report(uuid,uuid,date) to service_role;
notify pgrst,'reload schema';
commit;
