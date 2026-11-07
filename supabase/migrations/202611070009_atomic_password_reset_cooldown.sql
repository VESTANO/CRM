begin;
-- Keep username-first sign-in semantics, case-insensitive exact matching, and
-- current account status. Return ambiguous matches so the caller fails closed.
-- This resolver is service-only: no account/email details become public RPCs.
create function public.crm_password_reset_profile(p_identity text)
returns table(id uuid,email text,active boolean) language sql stable security definer set search_path=public,pg_temp as $$
  with candidates as (
    select p.id,p.email,p.active,
      case when lower(p.employee_id)=lower(trim(p_identity)) then 0 else 1 end priority
    from public.profiles p
    where lower(p.employee_id)=lower(trim(p_identity)) or lower(p.email)=lower(trim(p_identity))
    union all
    select p.id,p.email,p.active,2 from public.crm_legacy_auth l join public.profiles p on p.id=l.auth_user_id
    where l.is_active and lower(l.original_email)=lower(trim(p_identity))
  )
  select distinct c.id,c.email,c.active from candidates c where c.priority=(select min(priority) from candidates)
$$;
revoke all on function public.crm_password_reset_profile(text) from public,anon,authenticated;
grant execute on function public.crm_password_reset_profile(text) to service_role;

-- Claim the account's cooldown before any Auth/email side effect. The unique
-- key and conditional update serialize competing claims without storing email.
create function public.crm_claim_password_reset(p_email_hash text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_email_hash is null or p_email_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid password-reset claim.' using errcode='22023';
  end if;
  insert into public.crm_password_reset_requests(email_hash,requested_at) values(p_email_hash,now())
  on conflict(email_hash) do update set requested_at=excluded.requested_at
    where public.crm_password_reset_requests.requested_at<=now()-interval '60 seconds';
  return found;
end $$;
revoke all on function public.crm_claim_password_reset(text) from public,anon,authenticated;
grant execute on function public.crm_claim_password_reset(text) to service_role;
notify pgrst,'reload schema';
commit;
