-- Require the dispatch-only secret in addition to gateway JWT verification.
create or replace function public.invoke_crm_reminder_dispatch()
returns bigint language plpgsql security definer set search_path = public, extensions
as $$
declare project_url text; service_key text; dispatch_token text; request_id bigint;
begin
  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'crm_reminder_project_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'crm_reminder_service_key';
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name = 'crm_reminder_dispatch_token';
  if project_url is null or service_key is null or dispatch_token is null then return null; end if;
  select net.http_post(url := project_url || '/functions/v1/reminder-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || service_key, 'X-Reminder-Dispatch-Token', dispatch_token),
    body := '{}'::jsonb, timeout_milliseconds := 120000) into request_id;
  return request_id;
end;
$$;
revoke all on function public.invoke_crm_reminder_dispatch() from public, anon, authenticated;
