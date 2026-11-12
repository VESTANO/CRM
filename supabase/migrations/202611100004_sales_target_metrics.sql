-- Sales targets can be measured by the number of converted visits or their
-- total converted value. Existing targets remain count-based.
begin;

alter table public.crm_sales_targets
  alter column target type numeric(12, 2) using target::numeric(12, 2);

alter table public.crm_sales_targets
  add column if not exists metric text not null default 'count'
    check (metric in ('count', 'amount'));

commit;
