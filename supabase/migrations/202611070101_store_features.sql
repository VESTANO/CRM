-- Additive store-level module access. Existing stores retain every feature.
alter table public.crm_stores add column if not exists features jsonb not null default '{"customers":true,"sales":true,"attendance":true,"callbacks":true,"reminders":true,"reports":true,"tasks":true}'::jsonb;

alter table public.crm_stores add constraint crm_stores_features_shape check (
  jsonb_typeof(features) = 'object'
  and features ?& array['customers','sales','attendance','callbacks','reminders','reports','tasks']
  and (features - array['customers','sales','attendance','callbacks','reminders','reports','tasks']) = '{}'::jsonb
  and jsonb_typeof(features->'customers') = 'boolean'
  and jsonb_typeof(features->'sales') = 'boolean'
  and jsonb_typeof(features->'attendance') = 'boolean'
  and jsonb_typeof(features->'callbacks') = 'boolean'
  and jsonb_typeof(features->'reminders') = 'boolean'
  and jsonb_typeof(features->'reports') = 'boolean'
  and jsonb_typeof(features->'tasks') = 'boolean'
);

create or replace function public.store_feature_enabled_for_user(p_user_id uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select case when p.store_id is null and p.role = 'super_admin' then true
      else coalesce((s.features->>p_feature)::boolean, false) end
    from public.profiles p left join public.crm_stores s on s.id = p.store_id
    where p.id = p_user_id
  ), false);
$$;
revoke all on function public.store_feature_enabled_for_user(uuid,text) from public, anon;
grant execute on function public.store_feature_enabled_for_user(uuid,text) to authenticated, service_role;

-- Direct Supabase reads must respect the same store setting as the CRM API.
drop policy if exists entries_read_store_allowed on public.timesheet_entries;
create policy entries_read_store_allowed on public.timesheet_entries for select to authenticated
  using(public.current_user_role() is not null and public.can_view_store_member(user_id)
    and public.store_feature_enabled_for_user(user_id, 'attendance'));

drop policy if exists attendance_read_store_allowed on public.attendance_records;
create policy attendance_read_store_allowed on public.attendance_records for select to authenticated
  using(public.current_user_role() is not null and public.can_view_store_member(user_id)
    and public.store_feature_enabled_for_user(user_id, 'attendance'));

-- Timesheet RPCs use SECURITY DEFINER, so enforce writes in the table itself.
create or replace function public.guard_disabled_store_timesheet()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if TG_OP = 'DELETE' then
    if not public.store_feature_enabled_for_user(old.user_id, 'attendance') then
      raise exception 'Attendance is not enabled for this store.' using errcode = '42501';
    end if;
    return old;
  end if;
  if not public.store_feature_enabled_for_user(new.user_id, 'attendance') then
    raise exception 'Attendance is not enabled for this store.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_disabled_store_timesheet on public.timesheet_entries;
create trigger guard_disabled_store_timesheet before insert or update or delete on public.timesheet_entries
  for each row execute function public.guard_disabled_store_timesheet();

-- This RPC is SECURITY DEFINER, so its aggregate must filter disabled stores.
create or replace function public.get_dashboard_totals()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
declare result jsonb;
begin
  if public.current_user_role() is null then raise exception 'Active employee account required.'; end if;
  with visible_entries as (
    select * from public.timesheet_entries
    where public.can_view_store_member(user_id)
      and public.store_feature_enabled_for_user(user_id, 'attendance')
  )
  select jsonb_build_object(
    'hours',coalesce(sum(total_hours) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'overtime',coalesce(sum(overtime) filter (where date_trunc('month',work_date::timestamp)=date_trunc('month',now())),0),
    'billable',coalesce(sum(total_hours) filter (where billable),0),
    'pending',count(*) filter (where approval_status='Submitted'),
    'employees',(select count(*) from public.profiles where active and role not in ('super_admin','admin') and public.can_view_store_member(id) and public.store_feature_enabled_for_user(id, 'attendance'))
  ) into result from visible_entries;
  return result;
end;
$$;

-- Previously scheduled reminders stay stored but pause while the store's
-- Reminders feature is disabled. Re-enabling resumes normal delivery.
create or replace function public.claim_due_crm_reminders(batch_size integer default 20)
returns setof public.crm_reminders language sql security definer set search_path = public, pg_temp as $$
  with due as (
    select r.id from public.crm_reminders r
    where r.sent_at is null and r.reminder_at <= now()
      and public.store_feature_enabled_for_user(r.owner_id, 'reminders')
      and r.delivery_status in ('pending','retrying','no_subscriptions','processing')
      and (r.next_delivery_attempt_at is null or r.next_delivery_attempt_at <= now())
      and (r.delivery_status <> 'processing' or r.delivery_locked_at is null or r.delivery_locked_at < now() - interval '5 minutes')
    order by r.reminder_at, r.id limit least(greatest(batch_size, 1), 50) for update of r skip locked
  )
  update public.crm_reminders r set delivery_status = 'processing', delivery_locked_at = now(),
    delivery_attempt_count = r.delivery_attempt_count + 1, last_delivery_attempt_at = now()
  from due where r.id = due.id returning r.*;
$$;
revoke all on function public.claim_due_crm_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_due_crm_reminders(integer) to service_role;

notify pgrst, 'reload schema';
