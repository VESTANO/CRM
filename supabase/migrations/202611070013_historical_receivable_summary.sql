-- Old-schema records can contain an overpayment. Preserve those historical
-- records, but do not let one visit's credit hide another visit's receivable.
begin;
create or replace function public.crm_visit_summary(p_store uuid,p_owner uuid,p_today date) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('payments',jsonb_build_object(
    'totalAmount',coalesce(sum(total_amount),0),'paidAmount',coalesce(sum(paid_amount),0),
    'pendingAmount',coalesce(sum(greatest(total_amount-paid_amount,0)),0),
    'paidCount',count(*) filter(where paid_amount>0),'pendingCount',count(*) filter(where total_amount>paid_amount),
    'oneTimeCount',count(*) filter(where payment_status='one_time'),'completedCount',count(*) filter(where payment_status='completed')),
    'sales',jsonb_build_object('totalVisits',count(*),'todaysVisits',count(*) filter(where visit_date=p_today),
    'monthVisits',count(*) filter(where date_trunc('month',visit_date)=date_trunc('month',p_today)),
    'totalVisitExpenses',coalesce(sum(expense),0)))
  from public.crm_visits where store_id=p_store and (p_owner is null or owner_id=p_owner)
$$;
revoke all on function public.crm_visit_summary(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.crm_visit_summary(uuid,uuid,date) to service_role;
notify pgrst,'reload schema';
commit;
