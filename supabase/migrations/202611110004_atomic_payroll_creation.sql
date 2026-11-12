-- Create one complete payroll record atomically.  Payroll generation links
-- reimbursements, sales visits, advance recovery and an audit entry; keeping
-- those writes in one transaction prevents partial financial state when a
-- later write fails or two requests race for the same source record.
begin;

create or replace function public.crm_create_payroll_payment(
  p_store_id uuid,
  p_actor_id uuid,
  p_payment jsonb,
  p_expense_claim_ids uuid[] default '{}'::uuid[],
  p_visit_ids bigint[] default '{}'::bigint[],
  p_advance_repayments jsonb default '[]'::jsonb
) returns public.crm_payroll_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.crm_payroll_payments;
  v_claim public.crm_expense_claims;
  v_visit public.crm_visits;
  v_advance public.crm_salary_advances;
  v_repayment record;
  v_claim_id uuid;
  v_visit_id bigint;
  v_claim_count integer := 0;
  v_visit_count integer := 0;
begin
  insert into public.crm_payroll_payments (
    store_id, employee_id, payroll_month, salary_structure_id, basic_salary,
    allowance_amount, gross_amount, bonus_amount, overtime_hours,
    overtime_rate, overtime_amount, reimbursement_amount, expense_claim_amount,
    sales_expense_amount, lop_deduction, deduction_amount, advance_recovery,
    net_amount, paid_amount, remaining_amount, present_days, absent_days,
    paid_leave_days, unpaid_leave_days, calculation, payment_date,
    payment_method, reference_number, notes, status, created_by
  ) values (
    p_store_id, (p_payment->>'employee_id')::uuid,
    (p_payment->>'payroll_month')::date, (p_payment->>'salary_structure_id')::uuid,
    coalesce((p_payment->>'basic_salary')::numeric, 0),
    coalesce((p_payment->>'allowance_amount')::numeric, 0),
    coalesce((p_payment->>'gross_amount')::numeric, 0),
    coalesce((p_payment->>'bonus_amount')::numeric, 0),
    coalesce((p_payment->>'overtime_hours')::numeric, 0),
    coalesce((p_payment->>'overtime_rate')::numeric, 0),
    coalesce((p_payment->>'overtime_amount')::numeric, 0),
    coalesce((p_payment->>'reimbursement_amount')::numeric, 0),
    coalesce((p_payment->>'expense_claim_amount')::numeric, 0),
    coalesce((p_payment->>'sales_expense_amount')::numeric, 0),
    coalesce((p_payment->>'lop_deduction')::numeric, 0),
    coalesce((p_payment->>'deduction_amount')::numeric, 0),
    coalesce((p_payment->>'advance_recovery')::numeric, 0),
    coalesce((p_payment->>'net_amount')::numeric, 0), 0,
    coalesce((p_payment->>'remaining_amount')::numeric, 0),
    coalesce((p_payment->>'present_days')::numeric, 0),
    coalesce((p_payment->>'absent_days')::numeric, 0),
    coalesce((p_payment->>'paid_leave_days')::numeric, 0),
    coalesce((p_payment->>'unpaid_leave_days')::numeric, 0),
    coalesce(p_payment->'calculation', '{}'::jsonb),
    nullif(p_payment->>'payment_date', '')::date,
    coalesce(nullif(p_payment->>'payment_method', ''), 'bank_transfer'),
    coalesce(p_payment->>'reference_number', ''), coalesce(p_payment->>'notes', ''),
    coalesce(nullif(p_payment->>'status', ''), 'draft'), p_actor_id
  ) returning * into v_payment;

  foreach v_claim_id in array coalesce(p_expense_claim_ids, '{}'::uuid[])
  loop
    select * into v_claim from public.crm_expense_claims
      where id = v_claim_id and store_id = p_store_id
      for update;
    if not found or v_claim.employee_id <> v_payment.employee_id
      or v_claim.status <> 'approved' or not v_claim.reimbursable
      or v_claim.reimbursed_payment_id is not null then
      raise exception using errcode = 'P0001', message = 'Expense claim is no longer eligible for reimbursement.';
    end if;
    update public.crm_expense_claims set reimbursed_payment_id = v_payment.id, updated_at = now()
      where id = v_claim.id;
    insert into public.crm_payroll_expense_reimbursements(payment_id, expense_claim_id, amount)
      values (v_payment.id, v_claim.id, v_claim.amount);
    v_claim_count := v_claim_count + 1;
  end loop;
  if v_claim_count <> coalesce(cardinality(p_expense_claim_ids), 0) then
    raise exception using errcode = 'P0001', message = 'Duplicate expense claim in payroll request.';
  end if;

  foreach v_visit_id in array coalesce(p_visit_ids, '{}'::bigint[])
  loop
    select * into v_visit from public.crm_visits
      where id = v_visit_id and store_id = p_store_id and owner_id = v_payment.employee_id
      for update;
    if not found or coalesce(v_visit.expense, 0) <= 0 then
      raise exception using errcode = 'P0001', message = 'Sales visit is no longer eligible for reimbursement.';
    end if;
    insert into public.crm_payroll_visit_expenses(payment_id, visit_id, amount)
      values (v_payment.id, v_visit.id, v_visit.expense);
    v_visit_count := v_visit_count + 1;
  end loop;
  if v_visit_count <> coalesce(cardinality(p_visit_ids), 0) then
    raise exception using errcode = 'P0001', message = 'Duplicate sales visit in payroll request.';
  end if;

  for v_repayment in
    select * from jsonb_to_recordset(coalesce(p_advance_repayments, '[]'::jsonb))
      as value(advance_id uuid, amount numeric)
  loop
    if v_repayment.amount is null or v_repayment.amount <= 0 then
      raise exception using errcode = 'P0001', message = 'Invalid advance recovery amount.';
    end if;
    select * into v_advance from public.crm_salary_advances
      where id = v_repayment.advance_id and store_id = p_store_id
      for update;
    if not found or v_advance.employee_id <> v_payment.employee_id
      or v_advance.status <> 'approved' or v_advance.remaining_amount < v_repayment.amount then
      raise exception using errcode = 'P0001', message = 'Salary advance is no longer eligible for recovery.';
    end if;
    update public.crm_salary_advances
      set remaining_amount = remaining_amount - v_repayment.amount,
          status = case when remaining_amount - v_repayment.amount <= 0 then 'closed' else 'approved' end,
          updated_at = now()
      where id = v_advance.id;
    insert into public.crm_payroll_advance_repayments(payment_id, advance_id, amount)
      values (v_payment.id, v_advance.id, v_repayment.amount);
  end loop;

  insert into public.crm_payroll_audit(store_id, payment_id, entity_type, entity_id, action, details, actor_id)
    values (
      p_store_id, v_payment.id, 'payment', v_payment.id,
      case when v_payment.status = 'submitted' then 'submitted' else 'created' end,
      coalesce(p_payment->'audit_details', '{}'::jsonb), p_actor_id
    );
  return v_payment;
end;
$$;

revoke all on function public.crm_create_payroll_payment(uuid, uuid, jsonb, uuid[], bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.crm_create_payroll_payment(uuid, uuid, jsonb, uuid[], bigint[], jsonb) to service_role;

commit;
