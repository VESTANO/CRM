begin;
do $$
declare admin_id uuid; user_id uuid; saved jsonb; qa_task bigint; submission bigint; previous bigint;
begin
  select id into admin_id from public.profiles where active and role in ('admin','super_admin') limit 1;
  select id into user_id from public.profiles where active and role not in ('admin','super_admin') limit 1;
  saved := public.crm_save_task_photos(null,admin_id,'assignment',jsonb_build_object('assignee',user_id,'title','Transactional notification QA'),'[]');
  qa_task := (saved->>'id')::bigint;
  if (select count(*) from public.crm_task_notifications where task_id=qa_task and recipient_id=user_id and kind='assigned')<>1 then raise exception 'Assignment alert missing'; end if;
  perform public.crm_save_task_photos(qa_task,user_id,'completion','{"status":"submitted","submission_note":"Arranged"}','[]');
  select max(id) into submission from public.crm_task_submissions where task_id=qa_task;
  if (select count(*) from public.crm_task_notifications where task_id=qa_task and recipient_id=admin_id and kind='submitted')<>1 then raise exception 'Submission alert missing'; end if;
  perform public.crm_review_task_submission(qa_task,submission,admin_id,'reject','Arrange the top shelf too.');
  if not exists(select 1 from public.crm_task_notifications where task_id=qa_task and recipient_id=user_id and kind='rejected' and message like '%Arrange the top shelf too.%') then raise exception 'Rejection feedback alert missing'; end if;
  previous := submission;
  perform public.crm_save_task_photos(qa_task,user_id,'completion',jsonb_build_object('status','submitted','previous_submission_id',previous,'submission_note','Rearranged'),
    jsonb_build_array(jsonb_build_object('storage_path',user_id::text || '/' || gen_random_uuid() || '.png','original_name','new-after.png')));
  select max(id) into submission from public.crm_task_submissions where task_id=qa_task;
  if (select count(*) from public.crm_task_notifications where task_id=qa_task and recipient_id=admin_id and kind='resubmitted')<>1 then raise exception 'Resubmission alert missing'; end if;
  perform public.crm_review_task_submission(qa_task,submission,admin_id,'approve','Approved arrangement');
  if (select count(*) from public.crm_task_notifications where task_id=qa_task and recipient_id=user_id and kind='approved')<>1 then raise exception 'Approval alert missing'; end if;
  begin
    perform public.crm_review_task_submission(qa_task,submission,admin_id,'approve','Duplicate');
    raise exception 'Duplicate review accepted' using errcode='P0003';
  exception when sqlstate 'P0001' then null; end;
  if (select count(*) from public.crm_task_notifications where task_id=qa_task)<>5 then raise exception 'Duplicate or misdirected notifications'; end if;
  if has_table_privilege('authenticated','public.crm_task_notifications','insert') or has_table_privilege('authenticated','public.crm_task_notifications','update')
    or has_table_privilege('anon','public.crm_task_notifications','select') then raise exception 'Notification write/read permissions too broad'; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='crm_task_notifications') then raise exception 'Realtime publication missing'; end if;
  perform set_config('crm.qa_task',qa_task::text,true);
  perform set_config('crm.qa_admin',admin_id::text,true);
  perform set_config('crm.qa_user',user_id::text,true);
end $$;
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claim.sub',current_setting('crm.qa_user'),true);
  if (select count(*) from public.crm_task_notifications where task_id=current_setting('crm.qa_task')::bigint)<>3 then raise exception 'User cannot read own alerts or can read admin alerts'; end if;
  perform set_config('request.jwt.claim.sub',current_setting('crm.qa_admin'),true);
  if (select count(*) from public.crm_task_notifications where task_id=current_setting('crm.qa_task')::bigint)<>2 then raise exception 'Admin cannot read own alerts or can read user alerts'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  if exists(select 1 from public.crm_task_notifications where task_id=current_setting('crm.qa_task')::bigint) then raise exception 'Another account can read alerts'; end if;
end $$;
reset role;
select true as task_notification_checks_passed;
rollback;
