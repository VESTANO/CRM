-- REVIEW ONLY. Run against an explicitly authorized staging/backup restore
-- using the migration owner before applying the prepared 20261107 chain.
-- No credentials, password hashes or customer contents are selected.
begin;
set transaction read only;

select version() as database_version,current_user as migration_role;
select name,installed_version,default_version from pg_available_extensions
where name in ('pgcrypto','pg_trgm','pg_cron','pg_net','supabase_vault') order by name;
select to_regclass('vault.decrypted_secrets') is not null as vault_catalog_available,
  to_regclass('cron.job') is not null as scheduler_catalog_available,
  to_regclass('supabase_migrations.schema_migrations') is not null as migration_ledger_available;

select table_schema,table_name,column_name,data_type from information_schema.columns
where (table_schema='auth' and table_name='users' and column_name in ('id','encrypted_password','updated_at','last_sign_in_at','raw_app_meta_data'))
  or (table_schema='storage' and table_name='objects' and column_name in ('bucket_id','name','owner'))
order by table_schema,table_name,column_name;
select has_table_privilege(current_user,'auth.users','TRIGGER') as auth_trigger_privilege,
  pg_has_role(current_user,(select relowner from pg_class where oid='storage.objects'::regclass),'USAGE') as storage_owner_membership;

-- The Phase3 wrapper patch expects the committed task-notification definition.
-- A false result before005 is schema drift requiring review, not permission to
-- skip its guards or replace a working deployed function blindly.
select to_regprocedure('public.crm_save_task_photos(bigint,uuid,text,jsonb,jsonb)') is not null as task_photo_function_present,
  coalesce(position('and (id=task.assigned_by_id or id=previous_reviewer)' in pg_get_functiondef(to_regprocedure('public.crm_notify_task_submission()')))>0,false) as phase3_task_source_marker_present;

select count(*) as historical_overpaid_visits,
  coalesce(sum(greatest(paid_amount-total_amount,0)),0) as historical_credit,
  coalesce(sum(greatest(total_amount-paid_amount,0)),0) as per_visit_receivable,
  greatest(coalesce(sum(total_amount-paid_amount),0),0) as former_aggregate_receivable
from public.crm_visits;
select count(*) as customers,min(created_at) as earliest_create,min(updated_at) as earliest_edit,max(updated_at) as latest_edit
from public.crm_customer_records;

-- Binding010 may derive one unambiguous persisted business store. Globals with
-- employee-derived records but no unique evidence need explicit reconciliation.
with evidence as (
  select owner_id,store_id from public.crm_datasets
  union all select owner_id,store_id from public.crm_manual_clients
  union all select owner_id,store_id from public.crm_visits
  union all select owner_id,store_id from public.crm_reminders where store_id is not null
), grouped as (
  select owner_id,count(distinct store_id) stores from evidence group by owner_id
)
select count(*) as globals_requiring_ownership_review from public.profiles p
left join grouped g on g.owner_id=p.id
where p.role='super_admin' and p.store_id is null and coalesce(g.stores,0)<>1
  and (exists(select 1 from public.timesheet_entries where user_id=p.id)
    or exists(select 1 from public.attendance_records where user_id=p.id)
    or exists(select 1 from public.attendance_mappings where user_id=p.id)
    or exists(select 1 from public.crm_assigned_tasks where assignee_id=p.id)
    or exists(select 1 from public.crm_sales_targets where user_id=p.id)
    or exists(select 1 from public.crm_overtime_requests where employee_id=p.id));

select count(*) as legacy_credentials_to_revoke from public.crm_legacy_auth l
join auth.users u on u.id=l.auth_user_id where l.password_hash is not null
  and (u.last_sign_in_at is not null or u.updated_at>l.created_at);
select count(*) as orphan_customers from public.crm_customer_records r left join public.crm_datasets d on d.id=r.dataset_id where d.id is null;
select count(*) as orphan_visit_customers from public.crm_visits v left join public.crm_customer_records r on r.id=v.customer_id where v.customer_id is not null and r.id is null;
select count(*) as orphan_visit_clients from public.crm_visits v left join public.crm_manual_clients m on m.id=v.manual_client_id where v.manual_client_id is not null and m.id is null;
select conrelid::regclass as relation,conname,contype,convalidated from pg_constraint
where connamespace='public'::regnamespace and not convalidated order by 1,2;
select indrelid::regclass as relation,indexrelid::regclass as index_name,indisvalid,indisready
from pg_index where not indisvalid or not indisready order by 1,2;
select tablename,policyname,permissive,roles,cmd from pg_policies
where schemaname in ('public','storage') order by schemaname,tablename,policyname;
rollback;
