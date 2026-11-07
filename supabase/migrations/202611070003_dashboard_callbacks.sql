begin;
create function public.crm_visit_summary(p_store uuid,p_owner uuid,p_today date) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('payments',jsonb_build_object(
    'totalAmount',coalesce(sum(total_amount),0),'paidAmount',coalesce(sum(paid_amount),0),
    'pendingAmount',greatest(coalesce(sum(total_amount-paid_amount),0),0),
    'paidCount',count(*) filter(where paid_amount>0),'pendingCount',count(*) filter(where total_amount>paid_amount),
    'oneTimeCount',count(*) filter(where payment_status='one_time'),'completedCount',count(*) filter(where payment_status='completed')),
    'sales',jsonb_build_object('totalVisits',count(*),'todaysVisits',count(*) filter(where visit_date=p_today),
    'monthVisits',count(*) filter(where date_trunc('month',visit_date)=date_trunc('month',p_today)),
    'totalVisitExpenses',coalesce(sum(expense),0)))
  from public.crm_visits where store_id=p_store and (p_owner is null or owner_id=p_owner)
$$;
revoke all on function public.crm_visit_summary(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.crm_visit_summary(uuid,uuid,date) to service_role;

create function public.crm_callback_page(p_ids bigint[],p_today date,p_tomorrow date,p_date date,p_completed boolean,p_desc boolean,p_page integer)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare stats jsonb; total bigint; page integer; pages integer; records jsonb;
begin
  select jsonb_build_object('today',count(*) filter(where response='callback' and callback_completed_at is null and callback_date=p_today),
    'tomorrow',count(*) filter(where response='callback' and callback_completed_at is null and callback_date=p_tomorrow),
    'total',count(*) filter(where response='callback' and callback_completed_at is null),
    'calledBack',count(*) filter(where callback_completed_at is not null)) into stats
    from public.crm_customer_records where dataset_id=any(p_ids);
  select count(*) into total from public.crm_customer_records where dataset_id=any(p_ids)
    and (case when p_completed then callback_completed_at is not null else response='callback' and callback_completed_at is null end)
    and (p_date is null or callback_date=p_date);
  pages:=greatest(1,ceil(total::numeric/50)::integer); page:=least(greatest(1,coalesce(p_page,1)),pages);
  select coalesce(jsonb_agg(to_jsonb(r)),'[]') into records from (
    select * from public.crm_customer_records where dataset_id=any(p_ids)
      and (case when p_completed then callback_completed_at is not null else response='callback' and callback_completed_at is null end)
      and (p_date is null or callback_date=p_date)
    order by case when not p_completed and not p_desc then callback_date end asc nulls last,
      case when not p_completed and p_desc then callback_date end desc nulls last,
      case when not p_completed and not p_desc then updated_at end asc,
      case when p_completed or p_desc then updated_at end desc,
      case when p_completed then id end desc,id asc
    limit 50 offset (page-1)*50
  ) r;
  return jsonb_build_object('records',records,'counts',stats,'pagination',jsonb_build_object('page',page,'numPages',pages,'count',total));
end $$;
revoke all on function public.crm_callback_page(bigint[],date,date,date,boolean,boolean,integer) from public,anon,authenticated;
grant execute on function public.crm_callback_page(bigint[],date,date,date,boolean,boolean,integer) to service_role;
create index if not exists crm_pending_callbacks_page_idx on public.crm_customer_records(dataset_id,callback_date,updated_at,id) where response='callback' and callback_completed_at is null;
notify pgrst,'reload schema';
commit;
