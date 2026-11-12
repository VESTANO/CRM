-- Store-scoped monthly salary payments. Browser access is exclusively through
-- crm-api so salary details cannot be read across employees or stores.
begin;

create table if not exists public.crm_payroll_payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete restrict,
  payroll_month date not null check (payroll_month = date_trunc('month', payroll_month)::date),
  basic_salary numeric(14,2) not null default 0 check (basic_salary >= 0),
  bonus_amount numeric(14,2) not null default 0 check (bonus_amount >= 0),
  overtime_amount numeric(14,2) not null default 0 check (overtime_amount >= 0),
  deduction_amount numeric(14,2) not null default 0 check (deduction_amount >= 0),
  advance_recovery numeric(14,2) not null default 0 check (advance_recovery >= 0),
  net_amount numeric(14,2) not null check (net_amount >= 0),
  payment_date date,
  payment_method text not null default 'bank_transfer' check (payment_method in ('bank_transfer','cash','upi','cheque','other')),
  reference_number text not null default '' check (char_length(reference_number) <= 120),
  notes text not null default '' check (char_length(notes) <= 2000),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','paid')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, employee_id, payroll_month)
);

create index if not exists crm_payroll_payments_store_month_idx
  on public.crm_payroll_payments(store_id, payroll_month desc);
create index if not exists crm_payroll_payments_employee_month_idx
  on public.crm_payroll_payments(employee_id, payroll_month desc);

alter table public.crm_payroll_payments enable row level security;
revoke all on public.crm_payroll_payments from public, anon, authenticated;
grant select, insert, update, delete on public.crm_payroll_payments to service_role;

commit;
