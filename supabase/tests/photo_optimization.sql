-- Run with the photo optimization migration installed; all changes roll back.
begin;
do $$
declare admin_id uuid; user_id uuid; qa_task_id bigint; saved jsonb; photo jsonb; submission bigint;
begin
  select id into admin_id from public.profiles where active and role in ('admin','super_admin') limit 1;
  select id into user_id from public.profiles where active and role not in ('admin','super_admin') limit 1;
  if admin_id is null or user_id is null then raise exception 'Test requires admin and user profiles'; end if;
  photo := jsonb_build_object('storage_path',admin_id::text||'/'||gen_random_uuid()||'.webp','thumbnail_path',admin_id::text||'/'||gen_random_uuid()||'.thumb.webp','original_name','before.jpg','byte_size',128000,'thumbnail_byte_size',8000,'width',1280,'height',960);
  saved := public.crm_save_task_photos(null,admin_id,'assignment',jsonb_build_object('assignee',user_id,'title','Photo optimization transaction QA'),jsonb_build_array(photo));
  qa_task_id := (saved->>'id')::bigint;
  if not exists(select 1 from public.crm_task_images i where i.task_id=qa_task_id and i.thumbnail_path=photo->>'thumbnail_path' and i.byte_size=128000 and i.thumbnail_byte_size=8000 and i.width=1280 and i.height=960) then raise exception 'Assignment photo metadata missing'; end if;
  photo := photo || jsonb_build_object('storage_path',user_id::text||'/'||gen_random_uuid()||'.webp','thumbnail_path',user_id::text||'/'||gen_random_uuid()||'.thumb.webp','original_name','after.jpg');
  saved := public.crm_save_task_photos(qa_task_id,user_id,'completion','{"submission_note":"Arranged"}',jsonb_build_array(photo));
  select max(id) into submission from public.crm_task_submissions s where s.task_id=qa_task_id;
  if not exists(select 1 from public.crm_task_images i where i.task_id=qa_task_id and i.submission_id=submission and i.thumbnail_path=photo->>'thumbnail_path') then raise exception 'Submission image lost thumbnail or history'; end if;
  perform public.crm_review_task_submission(qa_task_id,submission,admin_id,'approve','Checked compressed photos');
  if not exists(select 1 from public.crm_assigned_tasks where id=qa_task_id and status='done') then raise exception 'Compressed photo review failed'; end if;
  begin
    update public.crm_task_images i set byte_size=262145 where i.task_id=qa_task_id;
    raise exception 'Oversized metadata was accepted';
  exception when check_violation then null; end;
  if exists(select 1 from storage.buckets where id in ('crm-task-images','crm-visit-images') and file_size_limit<>262144) then raise exception 'Storage cap missing'; end if;
end $$;
rollback;
