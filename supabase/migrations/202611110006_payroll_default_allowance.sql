alter table public.crm_payroll_settings
  add column if not exists default_allowance_amount numeric(14,2) not null default 0;

alter table public.crm_payroll_settings
  drop constraint if exists crm_payroll_settings_default_allowance_nonnegative,
  add constraint crm_payroll_settings_default_allowance_nonnegative
    check (default_allowance_amount >= 0);
