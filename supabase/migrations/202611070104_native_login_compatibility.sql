begin;
-- Existing browsers use this endpoint before the ordinary Auth password grant.
-- Resolve native store accounts here too, without changing any password or
-- revealing whether an identity belongs to the old import. Ambiguity fails shut.
create or replace function public.crm_legacy_login_account(p_identity text)
returns setof jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 with matches as (
  select coalesce(to_jsonb(l),'{}'::jsonb)||jsonb_build_object(
    'auth_user_id',p.id,'auth_email',p.email,'password_hash',l.password_hash) account,
    (lower(p.employee_id)=lower(btrim(p_identity)) or lower(l.username)=lower(btrim(p_identity))) username_match
  from public.profiles p left join public.crm_legacy_auth l on l.auth_user_id=p.id
  where p.active and (l.local_user_id is null or l.is_active)
    and char_length(p_identity) between 1 and 256
    and (lower(p.employee_id)=lower(btrim(p_identity))
      or lower(p.email)=lower(btrim(p_identity))
      or lower(l.username)=lower(btrim(p_identity))
      or lower(l.original_email)=lower(btrim(p_identity)))
 )
 select account from matches where username_match or not exists(select 1 from matches where username_match)
 limit 2;
$$;
revoke all on function public.crm_legacy_login_account(text) from public,anon,authenticated;
grant execute on function public.crm_legacy_login_account(text) to service_role;
notify pgrst,'reload schema';
commit;
