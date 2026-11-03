begin;
do $$
declare owner uuid; reminder bigint; device bigint; revision bigint; delivery bigint; received timestamptz;
begin
  select id into owner from auth.users order by created_at limit 1;
  if owner is null then raise exception 'A test account is required'; end if;
  insert into public.crm_reminders(owner_id,text,reminder_at) values(owner,'Transactional reminder QA',now()+interval '1 day') returning id,delivery_revision into reminder,revision;
  insert into public.crm_push_subscriptions(owner_id,endpoint,p256dh,auth) values(owner,'https://fcm.googleapis.com/transactional-reminder-qa','test','test') returning id into device;
  insert into public.crm_reminder_deliveries(reminder_id,subscription_id,delivery_revision,endpoint_hash,receipt_token_hash,receipt_expires_at,status)
    values(reminder,device,revision,'test',repeat('a',64),now()+interval '1 day','accepted') returning id into delivery;
  if public.record_crm_reminder_receipt(repeat('b',64),'displayed') then raise exception 'Invalid token accepted'; end if;
  if not public.record_crm_reminder_receipt(repeat('a',64),'displayed') then raise exception 'Valid receipt rejected'; end if;
  select displayed_at into received from public.crm_reminder_deliveries where id=delivery;
  if received is null then raise exception 'Missing receipt timestamp'; end if;
  perform public.record_crm_reminder_receipt(repeat('a',64),'displayed');
  if (select displayed_at from public.crm_reminder_deliveries where id=delivery) <> received then raise exception 'Receipt is not idempotent'; end if;
  update public.crm_reminders set reminder_at=reminder_at+interval '1 day' where id=reminder;
  if (select delivery_revision from public.crm_reminders where id=reminder) <> revision+1 then raise exception 'Reschedule did not create new occurrence'; end if;
  if public.record_crm_reminder_receipt(repeat('a',64),'clicked') then raise exception 'Obsolete receipt accepted'; end if;
  insert into public.crm_reminder_deliveries(reminder_id,subscription_id,delivery_revision,endpoint_hash) values(reminder,device,revision+1,'test');
  if has_function_privilege('authenticated','public.record_crm_reminder_receipt(text,text)','execute') then raise exception 'Receipt RPC is exposed to browser sessions'; end if;
end $$;
select true as receipt_auth_and_reschedule_checks_passed;
rollback;
