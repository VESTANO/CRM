begin;
-- Defense in depth: service-only task transactions must also enforce store
-- ownership. Keep all existing evidence, review-conflict and status rules.
alter function public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb) rename to crm_save_task_photos_internal;
revoke all on function public.crm_save_task_photos_internal(bigint,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.crm_save_task_photos(p_task_id bigint,p_actor uuid,p_stage text,p_values jsonb,p_images jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; target public.profiles;
begin
  select * into actor from public.profiles where id=p_actor and active;
  if not found then raise exception 'Active account required.' using errcode='42501'; end if;
  if p_task_id is null then
    select * into target from public.profiles where id=(p_values->>'assignee')::uuid;
  else
    select p.* into target from public.profiles p join public.crm_assigned_tasks t on t.assignee_id=p.id where t.id=p_task_id;
  end if;
  if not found or (actor.role<>'super_admin' and (actor.store_id is null or actor.store_id is distinct from target.store_id)) then
    raise exception 'Task not found in your store.' using errcode='42501';
  end if;
  return public.crm_save_task_photos_internal(p_task_id,p_actor,p_stage,p_values,p_images);
end $$;
revoke all on function public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb) to service_role;

alter function public.crm_review_task_submission(bigint,bigint,uuid,text,text) rename to crm_review_task_submission_internal;
revoke all on function public.crm_review_task_submission_internal(bigint,bigint,uuid,text,text) from public,anon,authenticated,service_role;
create function public.crm_review_task_submission(p_task_id bigint,p_submission_id bigint,p_actor uuid,p_action text,p_note text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; target_store uuid;
begin
  select * into actor from public.profiles where id=p_actor and active and role in ('admin','super_admin');
  if not found then raise exception 'Administrator access required.' using errcode='42501'; end if;
  select p.store_id into target_store from public.profiles p join public.crm_assigned_tasks t on t.assignee_id=p.id where t.id=p_task_id;
  if not found or (actor.role<>'super_admin' and (actor.store_id is null or actor.store_id is distinct from target_store)) then
    raise exception 'Task not found in your store.' using errcode='42501';
  end if;
  return public.crm_review_task_submission_internal(p_task_id,p_submission_id,p_actor,p_action,p_note);
end $$;
revoke all on function public.crm_review_task_submission(bigint,bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_review_task_submission(bigint,bigint,uuid,text,text) to service_role;

-- Assignment/review notifications remain transactional with the task. Limit
-- fallback reviewers to this store and global Super Admins, including when the
-- original assigning administrator has been disabled.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.crm_notify_task_submission()'::regprocedure);
  if position('and (id=task.assigned_by_id or id=previous_reviewer)' in definition)=0 then raise exception 'Unexpected task notification function'; end if;
  definition:=replace(definition,'and (id=task.assigned_by_id or id=previous_reviewer)',
    'and (role=''super_admin'' or store_id=(select store_id from public.profiles where id=task.assignee_id)) and (id=task.assigned_by_id or id=previous_reviewer)');
  definition:=replace(definition,'and id is distinct from new.submitted_by;',
    'and (role=''super_admin'' or store_id=(select store_id from public.profiles where id=task.assignee_id)) and id is distinct from new.submitted_by;');
  execute definition;
end $$;
notify pgrst,'reload schema';
commit;
