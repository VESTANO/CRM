-- Payroll overtime is entered as approved hours at an hourly rate. The stored
-- amount remains a snapshot so historical payslips remain correct if rates
-- later change.
begin;

alter table public.crm_payroll_payments
  add column if not exists overtime_hours numeric(10,2) not null default 0,
  add column if not exists overtime_rate numeric(14,2) not null default 0;

alter table public.crm_payroll_payments
  drop constraint if exists crm_payroll_payments_overtime_hours_nonnegative,
  add constraint crm_payroll_payments_overtime_hours_nonnegative check (overtime_hours >= 0),
  drop constraint if exists crm_payroll_payments_overtime_rate_nonnegative,
  add constraint crm_payroll_payments_overtime_rate_nonnegative check (overtime_rate >= 0);

commit;
