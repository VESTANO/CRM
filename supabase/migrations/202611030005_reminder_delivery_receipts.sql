alter table public.crm_reminders add column delivery_revision bigint not null default 1;
alter table public.crm_reminder_deliveries
  add column delivery_revision bigint not null default 1,
  add column receipt_token_hash text,
  add column receipt_expires_at timestamptz,
  add column received_at timestamptz,
  add column displayed_at timestamptz,
  add column clicked_at timestamptz;
alter table public.crm_reminder_deliveries drop constraint crm_reminder_deliveries_reminder_id_subscription_id_key;
alter table public.crm_reminder_deliveries add unique(reminder_id, subscription_id, delivery_revision);
create unique index crm_reminder_receipt_token_idx on public.crm_reminder_deliveries(receipt_token_hash) where receipt_token_hash is not null;

create function public.crm_reminder_new_schedule() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.reminder_at is distinct from old.reminder_at then
    new.delivery_revision := old.delivery_revision + 1;
    new.sent_at := null;
    new.delivery_status := 'pending';
    new.delivery_attempt_count := 0;
    new.last_delivery_attempt_at := null;
    new.next_delivery_attempt_at := null;
    new.delivery_locked_at := null;
    new.last_delivery_error := '';
  else
    new.delivery_revision := old.delivery_revision;
  end if;
  return new;
end $$;
create trigger crm_reminder_new_schedule before update on public.crm_reminders
for each row execute function public.crm_reminder_new_schedule();

-- A receipt authorizes only one delivery acknowledgement, never account access.
create function public.record_crm_reminder_receipt(token_hash text, receipt_event text)
returns boolean language plpgsql security definer set search_path = public as $$
declare delivery_id bigint;
begin
  if receipt_event not in ('received', 'displayed', 'clicked') then return false; end if;
  select d.id into delivery_id from public.crm_reminder_deliveries d
  join public.crm_reminders r on r.id = d.reminder_id
  where d.receipt_token_hash = token_hash and d.receipt_expires_at > now()
    and d.delivery_revision = r.delivery_revision;
  if delivery_id is null then return false; end if;
  update public.crm_reminder_deliveries set
    received_at = coalesce(received_at, now()),
    displayed_at = case when receipt_event in ('displayed','clicked') then coalesce(displayed_at, now()) else displayed_at end,
    clicked_at = case when receipt_event = 'clicked' then coalesce(clicked_at, now()) else clicked_at end
  where id = delivery_id;
  return true;
end $$;
revoke all on function public.record_crm_reminder_receipt(text,text) from public, anon, authenticated;
grant execute on function public.record_crm_reminder_receipt(text,text) to service_role;
