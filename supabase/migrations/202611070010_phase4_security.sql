begin;

-- Attendance, timesheets, tasks, targets and overtime inherit their employee's
-- store. Preserve that binding even while a promoted account is global, closing
-- the store A -> Super Admin -> store B transfer of historical records.
alter table public.profiles add column store_binding_id uuid references public.crm_stores(id) on delete restrict;
update public.profiles set store_binding_id=store_id where store_id is not null;
with history as (
  select owner_id,store_id from public.crm_datasets
  union all select owner_id,store_id from public.crm_manual_clients
  union all select owner_id,store_id from public.crm_visits
  union all select owner_id,store_id from public.crm_reminders where store_id is not null
  union all select owner_id,store_id from public.crm_import_jobs
), known as (
  select owner_id,(array_agg(distinct store_id))[1] store_id from history group by owner_id having count(distinct store_id)=1
)
update public.profiles p set store_binding_id=k.store_id from known k where p.id=k.owner_id and p.store_binding_id is null;
create function public.crm_preserve_profile_store() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare binding uuid;
begin
  if tg_op='UPDATE' then
    if new.store_binding_id is distinct from old.store_binding_id then
      raise exception 'An existing account cannot change its original store binding.' using errcode='23514';
    end if;
    binding:=coalesce(old.store_binding_id,old.store_id);
  else
    binding:=new.store_id;
    if new.store_binding_id is not null and new.store_binding_id is distinct from binding then
      raise exception 'The original store binding must match the account store.' using errcode='23514';
    end if;
  end if;
  if new.role='super_admin' and new.store_id is not null then
    raise exception 'Super Admin accounts must be global.' using errcode='23514';
  end if;
  if new.store_id is not null then
    if binding is not null and binding is distinct from new.store_id then
      raise exception 'This account must return to its original store. Create a new account for another store.' using errcode='23514';
    end if;
    if tg_op='UPDATE' and binding is null and (
      exists(select 1 from public.timesheet_entries where user_id=new.id)
      or exists(select 1 from public.attendance_records where user_id=new.id)
      or exists(select 1 from public.attendance_mappings where user_id=new.id)
      or exists(select 1 from public.crm_assigned_tasks where assignee_id=new.id)
      or exists(select 1 from public.crm_sales_targets where user_id=new.id)
      or exists(select 1 from public.crm_overtime_requests where employee_id=new.id)
    ) then
      raise exception 'Historical store ownership is unresolved. An administrator must reconcile it before assigning this account.' using errcode='23514';
    end if;
    binding:=new.store_id;
  end if;
  new.store_binding_id:=binding;
  return new;
end $$;
revoke all on function public.crm_preserve_profile_store() from public,anon,authenticated,service_role;
create trigger crm_preserve_profile_store before insert or update on public.profiles
for each row execute function public.crm_preserve_profile_store();

-- The original import did not record the original Auth password fingerprint.
-- A subsequent Auth update or successful sign-in means its old Django hash can
-- no longer be trusted as an upgrade credential. These accounts use their
-- current password or the normal recovery/admin-reset workflow after rollout.
update public.crm_legacy_auth l set password_hash=null,
  password_upgraded_at=coalesce(l.password_upgraded_at,now()),updated_at=now()
from auth.users u where u.id=l.auth_user_id and l.password_hash is not null
  and (u.last_sign_in_at is not null or u.updated_at>l.created_at);

-- A retained Django credential must never replace a password subsequently set
-- by recovery, an administrator, or the authenticated account itself. Keep the
-- revocation in the same Auth transaction, irrespective of the API used.
create function public.crm_revoke_legacy_password() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare legacy_password text;
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    if coalesce(new.raw_app_meta_data,'{}'::jsonb) ? 'crm_legacy_password_upgrade' then
      -- Legacy verification happened before the HTTP Auth call. Recheck under
      -- the Auth row lock so an intervening reset cannot be overwritten by a
      -- previously verified old password. Only the service admin can set this
      -- app-metadata marker; never persist or include it in issued tokens.
      select l.password_hash into legacy_password from public.crm_legacy_auth l
      join public.profiles p on p.id=l.auth_user_id
      where l.auth_user_id=new.id and l.is_active and p.active for update of l;
      if legacy_password is null then
        raise exception 'This legacy credential has already been replaced.' using errcode='40001';
      end if;
    end if;
    update public.crm_legacy_auth set password_hash=null,
      password_upgraded_at=coalesce(password_upgraded_at,now()),updated_at=now()
    where auth_user_id=new.id and password_hash is not null;
  end if;
  new.raw_app_meta_data:=coalesce(new.raw_app_meta_data,'{}'::jsonb)-'crm_legacy_password_upgrade';
  return new;
end $$;
revoke all on function public.crm_revoke_legacy_password() from public,anon,authenticated,service_role;
create trigger crm_revoke_legacy_password before update of encrypted_password on auth.users
for each row execute function public.crm_revoke_legacy_password();

-- Resolve in SQL with literal case-insensitive comparisons. Current account
-- activity and email are authoritative; stale import flags/email cannot enable
-- a disabled profile or log in to a different recycled email address.
create index crm_legacy_auth_username_lower_idx on public.crm_legacy_auth(lower(username));
create index crm_legacy_auth_original_email_lower_idx on public.crm_legacy_auth(lower(original_email));
create function public.crm_legacy_login_account(p_identity text)
returns setof jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
  with matches as (
    select l.*,p.email as current_email,
      lower(l.username)=lower(btrim(p_identity)) as username_match
    from public.crm_legacy_auth l join public.profiles p on p.id=l.auth_user_id
    where p.active and l.is_active and char_length(p_identity) between 1 and 256
      and (lower(l.username)=lower(btrim(p_identity))
        or lower(l.original_email)=lower(btrim(p_identity))
        or lower(p.email)=lower(btrim(p_identity)))
  )
  select (to_jsonb(m)-'current_email'-'username_match')
    ||jsonb_build_object('auth_email',m.current_email)
  from matches m where username_match or not exists(select 1 from matches where username_match)
  limit 2;
$$;
revoke all on function public.crm_legacy_login_account(text) from public,anon,authenticated;
grant execute on function public.crm_legacy_login_account(text) to service_role;

-- The one-time import crosses Auth, Storage and PostgreSQL. Claim its token
-- before the first write; a failed attempt must be inspected before reissuance,
-- never blindly replayed while partial external changes may already exist.
create function public.crm_claim_legacy_migration(p_token_hash text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  update public.crm_migration_authorizations set used_at=now()
  where token_hash=p_token_hash and used_at is null and expires_at>now();
  return found;
end $$;
revoke all on function public.crm_claim_legacy_migration(text) from public,anon,authenticated;
grant execute on function public.crm_claim_legacy_migration(text) to service_role;

-- CRM photos are always mediated by the authorized Edge API. A restrictive
-- policy also closes accidental access through an unrelated broad permissive
-- Storage policy; it grants no access and does not alter other buckets.
update storage.buckets set public=false where id in ('crm-task-images','crm-visit-images');
create policy crm_private_images_api_only on storage.objects as restrictive
for all to anon,authenticated
using (bucket_id not in ('crm-task-images','crm-visit-images'))
with check (bucket_id not in ('crm-task-images','crm-visit-images'));
notify pgrst,'reload schema';
commit;
