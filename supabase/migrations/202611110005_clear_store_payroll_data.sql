create or replace function public.crm_clear_payroll_store(
  p_actor uuid,
  p_store uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb;
begin
  if p_actor is null or p_store is null then
    raise exception 'Actor and store are required.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_actor and active = true and role = 'super_admin'
  ) then
    raise exception 'Only an active Super Admin can clear payroll data.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.crm_stores where id = p_store) then
    raise exception 'Store not found.' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'settings', (select count(*) from public.crm_payroll_settings where store_id = p_store),
    'salary_structures', (select count(*) from public.crm_salary_structures where store_id = p_store),
    'expense_claims', (select count(*) from public.crm_expense_claims where store_id = p_store),
    'salary_advances', (select count(*) from public.crm_salary_advances where store_id = p_store),
    'payroll_payments', (select count(*) from public.crm_payroll_payments where store_id = p_store),
    'payment_transactions', (select count(*) from public.crm_salary_payment_transactions where store_id = p_store),
    'audit_records', (select count(*) from public.crm_payroll_audit where store_id = p_store)
  ) into v_counts;

  delete from public.crm_salary_payment_transactions where store_id = p_store;
  delete from public.crm_payroll_expense_reimbursements
    where payment_id in (select id from public.crm_payroll_payments where store_id = p_store);
  delete from public.crm_payroll_visit_expenses
    where payment_id in (select id from public.crm_payroll_payments where store_id = p_store);
  delete from public.crm_payroll_advance_repayments
    where payment_id in (select id from public.crm_payroll_payments where store_id = p_store);
  delete from public.crm_payroll_audit where store_id = p_store;
  delete from public.crm_payroll_payments where store_id = p_store;
  delete from public.crm_expense_claims where store_id = p_store;
  delete from public.crm_salary_advances where store_id = p_store;
  delete from public.crm_salary_structures where store_id = p_store;
  delete from public.crm_payroll_settings where store_id = p_store;

  return jsonb_build_object('store_id', p_store, 'deleted', v_counts);
end;
$$;

revoke all on function public.crm_clear_payroll_store(uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_clear_payroll_store(uuid, uuid) to service_role;
