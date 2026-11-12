-- Complete store-scoped payroll data model. Existing payment rows remain valid;
-- new columns retain their previous values until a payroll calculation is run.
begin;

alter table public.attendance_leave_days
  add column if not exists leave_type text not null default 'paid';
alter table public.attendance_leave_days
  drop constraint if exists attendance_leave_days_leave_type_check,
  add constraint attendance_leave_days_leave_type_check check (leave_type in ('paid','unpaid'));

create table if not exists public.crm_payroll_settings (
  store_id uuid primary key references public.crm_stores(id) on delete cascade,
  payroll_days_per_month numeric(5,2) not null default 26 check (payroll_days_per_month > 0 and payroll_days_per_month <= 31),
  paid_leave_allowance numeric(5,2) not null default 0 check (paid_leave_allowance >= 0),
  default_overtime_rate numeric(14,2) not null default 0 check (default_overtime_rate >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_salary_structures (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  effective_from date not null,
  basic_salary numeric(14,2) not null check (basic_salary >= 0),
  allowance_amount numeric(14,2) not null default 0 check (allowance_amount >= 0),
  overtime_rate numeric(14,2) not null default 0 check (overtime_rate >= 0),
  bank_account_holder text not null default '' check (char_length(bank_account_holder) <= 160),
  bank_name text not null default '' check (char_length(bank_name) <= 160),
  bank_account_number text not null default '' check (char_length(bank_account_number) <= 80),
  bank_ifsc text not null default '' check (char_length(bank_ifsc) <= 32),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (employee_id, effective_from)
);
create index if not exists crm_salary_structures_store_employee_date_idx on public.crm_salary_structures(store_id, employee_id, effective_from desc);

create table if not exists public.crm_expense_claims (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  expense_date date not null,
  category text not null default 'Other' check (char_length(category) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  amount numeric(14,2) not null check (amount > 0),
  reimbursable boolean not null default true,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '' check (char_length(review_note) <= 1000),
  reimbursed_payment_id uuid references public.crm_payroll_payments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_expense_claims_store_employee_status_idx on public.crm_expense_claims(store_id, employee_id, status, expense_date desc);
create unique index if not exists crm_expense_claims_reimbursement_once_idx on public.crm_expense_claims(reimbursed_payment_id, id) where reimbursed_payment_id is not null;

create table if not exists public.crm_salary_advances (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  requested_amount numeric(14,2) not null check (requested_amount > 0),
  approved_amount numeric(14,2) not null default 0 check (approved_amount >= 0),
  remaining_amount numeric(14,2) not null default 0 check (remaining_amount >= 0),
  reason text not null default '' check (char_length(reason) <= 1000),
  status text not null default 'submitted' check (status in ('submitted','approved','rejected','closed')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '' check (char_length(review_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_salary_advances_store_employee_status_idx on public.crm_salary_advances(store_id, employee_id, status, created_at desc);

alter table public.crm_payroll_payments
  add column if not exists salary_structure_id uuid references public.crm_salary_structures(id) on delete set null,
  add column if not exists allowance_amount numeric(14,2) not null default 0,
  add column if not exists gross_amount numeric(14,2) not null default 0,
  add column if not exists reimbursement_amount numeric(14,2) not null default 0,
  add column if not exists lop_deduction numeric(14,2) not null default 0,
  add column if not exists present_days numeric(6,2) not null default 0,
  add column if not exists absent_days numeric(6,2) not null default 0,
  add column if not exists paid_leave_days numeric(6,2) not null default 0,
  add column if not exists unpaid_leave_days numeric(6,2) not null default 0,
  add column if not exists calculation jsonb not null default '{}'::jsonb,
  add column if not exists paid_amount numeric(14,2) not null default 0,
  add column if not exists remaining_amount numeric(14,2) not null default 0,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid references public.profiles(id) on delete set null;

create table if not exists public.crm_payroll_expense_reimbursements (
  payment_id uuid not null references public.crm_payroll_payments(id) on delete cascade,
  expense_claim_id uuid not null references public.crm_expense_claims(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  primary key (payment_id, expense_claim_id),
  unique (expense_claim_id)
);

create table if not exists public.crm_payroll_advance_repayments (
  payment_id uuid not null references public.crm_payroll_payments(id) on delete cascade,
  advance_id uuid not null references public.crm_salary_advances(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  primary key (payment_id, advance_id)
);

create table if not exists public.crm_salary_payment_transactions (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.crm_payroll_payments(id) on delete cascade,
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  payment_date date not null,
  payment_method text not null check (payment_method in ('bank_transfer','cash','upi','cheque','other')),
  reference_number text not null default '' check (char_length(reference_number) <= 120),
  notes text not null default '' check (char_length(notes) <= 1000),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists crm_salary_payment_transactions_payment_idx on public.crm_salary_payment_transactions(payment_id, payment_date desc);

create table if not exists public.crm_payroll_audit (
  id bigint generated by default as identity primary key,
  store_id uuid not null references public.crm_stores(id) on delete cascade,
  payment_id uuid references public.crm_payroll_payments(id) on delete cascade,
  entity_type text not null check (entity_type in ('salary_structure','payment','expense','advance','settings')),
  entity_id uuid,
  action text not null check (char_length(action) between 1 and 80),
  details jsonb not null default '{}'::jsonb,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists crm_payroll_audit_store_created_idx on public.crm_payroll_audit(store_id, created_at desc);

alter table public.crm_payroll_settings enable row level security;
alter table public.crm_salary_structures enable row level security;
alter table public.crm_expense_claims enable row level security;
alter table public.crm_salary_advances enable row level security;
alter table public.crm_payroll_expense_reimbursements enable row level security;
alter table public.crm_payroll_advance_repayments enable row level security;
alter table public.crm_payroll_audit enable row level security;
alter table public.crm_salary_payment_transactions enable row level security;
revoke all on public.crm_payroll_settings, public.crm_salary_structures, public.crm_expense_claims, public.crm_salary_advances, public.crm_payroll_expense_reimbursements, public.crm_payroll_advance_repayments, public.crm_payroll_audit, public.crm_salary_payment_transactions from public, anon, authenticated;
grant select, insert, update, delete on public.crm_payroll_settings, public.crm_salary_structures, public.crm_expense_claims, public.crm_salary_advances, public.crm_payroll_expense_reimbursements, public.crm_payroll_advance_repayments, public.crm_payroll_audit, public.crm_salary_payment_transactions to service_role;
grant usage, select on sequence public.crm_payroll_audit_id_seq to service_role;

commit;
