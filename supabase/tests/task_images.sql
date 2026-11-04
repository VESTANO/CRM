-- No test rows are committed or visible to live user feeds.
begin;
do $$
declare admin_id uuid; user_id uuid; saved jsonb; qa_task_id bigint; before_images jsonb; after_images jsonb;
begin
  select id into admin_id from public.profiles where active and role in ('admin', 'super_admin') limit 1;
  select id into user_id from public.profiles where active and role not in ('admin', 'super_admin') limit 1;
  if admin_id is null or user_id is null then raise exception 'Test needs an admin and a normal account'; end if;
  select jsonb_agg(jsonb_build_object('storage_path',admin_id::text || '/' || gen_random_uuid() || '.png','original_name','before.png'))
    into before_images from generate_series(1,2);
  select jsonb_agg(jsonb_build_object('storage_path',user_id::text || '/' || gen_random_uuid() || '.png','original_name','after.png'))
    into after_images from generate_series(1,2);
  saved := public.crm_save_task_photos(null,admin_id,'assignment',jsonb_build_object('assignee',user_id,'title','Transactional photo QA'),before_images);
  qa_task_id := (saved->>'id')::bigint;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion','{"status":"submitted"}','[]');
    raise exception 'Accepted photo task without new After photos';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.crm_save_task_photos(qa_task_id,admin_id,'completion','{}',after_images);
    raise exception 'Accepted another account upload';
  exception when no_data_found then null; end;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion','{}',before_images);
    raise exception 'Accepted another uploader path';
  exception when invalid_parameter_value then null; end;
  if exists (select 1 from public.crm_task_submissions where task_id=qa_task_id) then raise exception 'Failed upload left a partial submission'; end if;
  saved := public.crm_save_task_photos(qa_task_id,user_id,'completion','{"status":"done","submission_note":"Arranged"}',after_images);
  if saved->>'status' <> 'submitted' or saved->>'completed_at' is not null then raise exception 'User bypassed approval'; end if;
  if (select count(*) from public.crm_task_images where task_id=qa_task_id) <> 4 then raise exception 'Missing photos'; end if;
  if exists(select 1 from public.crm_task_images where task_id=qa_task_id and stage='completion' and submission_id is null) then raise exception 'Unversioned After photos'; end if;
  if has_table_privilege('authenticated','public.crm_task_images','select') or (select public from storage.buckets where id='crm-task-images') then raise exception 'Task photos are publicly exposed'; end if;
end $$;
select true as task_photo_checks_passed;
rollback;
