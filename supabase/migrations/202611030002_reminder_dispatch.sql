create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create or replace function public.claim_due_crm_reminders(batch_size integer default 20)
returns setof public.crm_reminders language sql security definer set search_path = public
as $$
  with due as (
    select id from public.crm_reminders
    where sent_at is null and reminder_at <= now()
      and delivery_status in ('pending', 'retrying', 'no_subscriptions', 'processing')
      and (next_delivery_attempt_at is null or next_delivery_attempt_at <= now())
      and (delivery_status <> 'processing' or delivery_locked_at < now() - interval '5 minutes')
    order by reminder_at, id limit least(greatest(batch_size, 1), 50)
    for update skip locked
  )
  update public.crm_reminders r set delivery_status = 'processing', delivery_locked_at = now(),
    delivery_attempt_count = delivery_attempt_count + 1, last_delivery_attempt_at = now()
  from due where r.id = due.id returning r.*;
$$;
revoke all on function public.claim_due_crm_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_due_crm_reminders(integer) to service_role;

-- Keep credentials in Vault, never in cron command text or source control.
-- Provision these two secrets before enabling the named job.
create or replace function public.invoke_crm_reminder_dispatch()
returns bigint language plpgsql security definer set search_path = public, extensions
as $$
declare project_url text; service_key text; request_id bigint;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'crm_reminder_project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'crm_reminder_service_key';
  if project_url is null or service_key is null then return null; end if;
  select net.http_post(url := project_url || '/functions/v1/reminder-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || service_key),
    body := '{}'::jsonb, timeout_milliseconds := 120000) into request_id;
  return request_id;
end;
$$;
revoke all on function public.invoke_crm_reminder_dispatch() from public, anon, authenticated;
-- Named job is idempotent; later migrations/deployments do not remove it.
select cron.schedule('crm-reminder-dispatch', '* * * * *', 'select public.invoke_crm_reminder_dispatch();');
