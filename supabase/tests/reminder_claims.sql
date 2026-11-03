begin;
create temporary table reminder_claim_test on commit drop as select * from public.claim_due_crm_reminders(20);
do $$
begin
  if exists(select 1 from reminder_claim_test where reminder_at > now() or delivery_status <> 'processing') then
    raise exception 'Claim selected an ineligible reminder';
  end if;
  if exists(select 1 from public.claim_due_crm_reminders(20)) then
    raise exception 'A reminder was claimed twice';
  end if;
  if has_function_privilege('authenticated', 'public.claim_due_crm_reminders(integer)', 'execute') then
    raise exception 'Browser users may not claim reminders';
  end if;
end $$;
select count(*) as claimed_due_reminders, true as duplicate_claims_prevented,
  true as future_reminders_excluded, true as browser_claims_blocked from reminder_claim_test;
rollback;
