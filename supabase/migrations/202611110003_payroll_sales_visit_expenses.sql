-- Sales visit expenses are reimbursed through payroll only once.  The visit
-- itself remains the source of truth; this table records the payroll snapshot.
begin;

alter table public.crm_payroll_payments
  add column if not exists sales_expense_amount numeric(14,2) not null default 0
    check (sales_expense_amount >= 0),
  add column if not exists expense_claim_amount numeric(14,2) not null default 0
    check (expense_claim_amount >= 0);

create table if not exists public.crm_payroll_visit_expenses (
  payment_id uuid not null references public.crm_payroll_payments(id) on delete cascade,
  visit_id bigint not null references public.crm_visits(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  primary key (payment_id, visit_id),
  unique (visit_id)
);

create index if not exists crm_payroll_visit_expenses_payment_idx
  on public.crm_payroll_visit_expenses(payment_id);

alter table public.crm_payroll_visit_expenses enable row level security;
revoke all on public.crm_payroll_visit_expenses from public, anon, authenticated;
grant select, insert, update, delete on public.crm_payroll_visit_expenses to service_role;

commit;
