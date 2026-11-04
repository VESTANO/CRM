begin;
do $$
declare
  admin_id uuid; user_id uuid; saved jsonb; qa_task_id bigint; first_id bigint; next_id bigint;
  before_images jsonb; after_images jsonb; replacement_images jsonb;
begin
  select id into admin_id from public.profiles where active and role in ('admin','super_admin') limit 1;
  select id into user_id from public.profiles where active and role not in ('admin','super_admin') limit 1;
  if admin_id is null or user_id is null then raise exception 'Test needs an admin and a normal account'; end if;
  before_images := jsonb_build_array(jsonb_build_object('storage_path',admin_id::text || '/' || gen_random_uuid() || '.png','original_name','before.png'));
  after_images := jsonb_build_array(jsonb_build_object('storage_path',user_id::text || '/' || gen_random_uuid() || '.png','original_name','after.png'));
  saved := public.crm_save_task_photos(null,admin_id,'assignment',jsonb_build_object('assignee',user_id,'title','Transactional review QA'),before_images);
  qa_task_id := (saved->>'id')::bigint;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion',jsonb_build_object('submission_note',repeat('x',4001)),after_images);
    raise exception 'Accepted an oversized note';
  exception when check_violation then null; end;
  if exists(select 1 from public.crm_task_submissions where task_id=qa_task_id) then raise exception 'Failed submission left metadata'; end if;
  saved := public.crm_save_task_photos(qa_task_id,user_id,'completion','{"status":"submitted","submission_note":"Arranged the lower shelves","title":"Forged"}',after_images);
  if saved->>'status' <> 'submitted' or saved->>'title' <> 'Transactional review QA' or saved->>'completed_at' is not null then raise exception 'Submission state or field restrictions failed'; end if;
  select max(id) into first_id from public.crm_task_submissions where task_id=qa_task_id;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion','{}',after_images);
    raise exception 'Allowed a second submission before review' using errcode = 'P0003';
  exception when sqlstate 'P0001' then null; end;
  begin
    perform public.crm_review_task_submission(qa_task_id,first_id,user_id,'approve','Self approved');
    raise exception 'User approved own work';
  exception when insufficient_privilege then null; end;
  begin
    perform public.crm_review_task_submission(qa_task_id,first_id,admin_id,'reject','  ');
    raise exception 'Allowed rejection without feedback';
  exception when invalid_parameter_value then null; end;
  saved := public.crm_review_task_submission(qa_task_id,first_id,admin_id,'reject','Arrange the top shelf too.');
  if saved->>'status' <> 'rejected' or saved->>'completed_at' is not null then raise exception 'Rejection did not return work to user'; end if;
  if not exists(select 1 from public.crm_task_submissions where id=first_id and note='Arranged the lower shelves' and review_note='Arrange the top shelf too.' and reviewed_by=admin_id) then raise exception 'Missing user or admin note'; end if;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion','{}',after_images);
    raise exception 'Stale rework draft accepted' using errcode = 'P0003';
  exception when sqlstate 'P0001' then null; end;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion',jsonb_build_object('previous_submission_id',first_id),'[]');
    raise exception 'Reused previous After photos without a new upload';
  exception when invalid_parameter_value then null; end;
  select jsonb_agg(jsonb_build_object('storage_path',user_id::text || '/' || gen_random_uuid() || '.png','original_name','rearranged.png'))
    into replacement_images from generate_series(1,10);
  saved := public.crm_save_task_photos(qa_task_id,user_id,'completion',jsonb_build_object('status','submitted','previous_submission_id',first_id,'submission_note','Top shelf arranged too'),replacement_images);
  if saved->>'status' <> 'submitted' then raise exception 'Rework did not enter review'; end if;
  select max(id) into next_id from public.crm_task_submissions where task_id=qa_task_id;
  if next_id=first_id or (select count(*) from public.crm_task_submissions where task_id=qa_task_id) <> 2 then raise exception 'Submission history overwritten'; end if;
  if (select count(*) from public.crm_task_images where task_id=qa_task_id and stage='completion') <> 11 then raise exception 'Per-attempt limit or photo history failed'; end if;
  begin
    perform public.crm_review_task_submission(qa_task_id,first_id,admin_id,'approve','Old review');
    raise exception 'Stale review approved a newer submission' using errcode = 'P0003';
  exception when sqlstate 'P0001' then null; end;
  saved := public.crm_review_task_submission(qa_task_id,next_id,admin_id,'approve','Looks arranged now.');
  if saved->>'status' <> 'done' or saved->>'completed_at' is null then raise exception 'Approval did not complete task'; end if;
  if not exists(select 1 from public.crm_task_submissions where id=next_id and status='approved' and note='Top shelf arranged too' and review_note='Looks arranged now.') then raise exception 'Approval notes missing'; end if;
  begin
    perform public.crm_review_task_submission(qa_task_id,next_id,admin_id,'reject','Duplicate decision');
    raise exception 'Allowed duplicate review' using errcode = 'P0003';
  exception when sqlstate 'P0001' then null; end;
  begin
    perform public.crm_save_task_photos(qa_task_id,user_id,'completion','{"status":"done"}',after_images);
    raise exception 'User changed approved evidence' using errcode = 'P0003';
  exception when sqlstate 'P0001' then null; end;
  if has_function_privilege('authenticated','public.crm_review_task_submission(bigint,bigint,uuid,text,text)','execute')
    or has_function_privilege('anon','public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb)','execute')
    or has_table_privilege('authenticated','public.crm_task_submissions','select') then raise exception 'Review functions or history exposed directly'; end if;
end $$;
select true as task_review_checks_passed;
rollback;
