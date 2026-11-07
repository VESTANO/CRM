"""Native PostgreSQL EXPLAIN ANALYZE on a new synthetic, loopback QA database.

Requires the separately initialized QA cluster and installed psycopg. No hosted
credentials or application database are read. The database is retained as audit
evidence; this script never drops a database or modifies the cluster settings.
"""
from pathlib import Path
import json
import statistics
import uuid
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
CONFIG = dict(host='127.0.0.1', port=55483, user='phase4_qa', connect_timeout=5)
DATABASE = 'crm_phase4_perf_' + uuid.uuid4().hex[:10]
SIZE = 25000
A, C, B, SA, SB = [str(uuid.UUID(int=n)) for n in (1, 2, 3, 11, 12)]
REPORT = dict(database=DATABASE, transport='127.0.0.1:55483', rowsPerModule=SIZE, plans={}, payloads={}, assertions=[], limitations=[
    'Loopback native PostgreSQL, synthetic single-client warm runs; not hosted load or browser measurements',
    'Exact counts, arbitrary-field search and deep offset pages still scan rows',
    'Task and overtime endpoint complete-history transfer remains; task serializer batches do not solve that',
    'Attendance plans verify query shape and existing indexes, not device delivery or business-rule certification'])

def connection(database):
    db = psycopg.connect(**CONFIG, dbname=database, autocommit=True)
    db.execute("set statement_timeout='30s'")
    db.execute("set lock_timeout='10s'")
    return db

def value(db, sql, params=None):
    return db.execute(sql, params).fetchone()[0]

def explain(db, name, sql, params=None):
    runs = [value(db, 'explain(analyze,buffers,format json) ' + sql, params)[0] for _ in range(3)]
    median = statistics.median(p['Execution Time'] for p in runs)
    REPORT['plans'][name] = dict(medianExecutionMs=median, runs=runs)
    print(name + ': ' + str(median) + ' ms median', flush=True)
    return runs[-1]

with connection('postgres') as admin:
    assert value(admin, 'select current_user') == 'phase4_qa'
    REPORT['server'] = value(admin, 'select version()')
    admin.execute('create database ' + DATABASE)
    admin.execute("""do $$begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end$$""")

with connection(DATABASE) as db:
    db.execute("""create schema auth;create schema storage;
      create table auth.users(id uuid primary key,encrypted_password text,updated_at timestamptz default now(),last_sign_in_at timestamptz,raw_app_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select 'authenticated'::text$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      create publication supabase_realtime;""")
    original = ['202611020001_crm_core','202611020002_crm_legacy_import','202611020003_crm_profile_service_role',
        '202611030001_visit_optional_meeting_fields','202611030004_reminder_updated_at','202611030005_reminder_delivery_receipts',
        '202611030009_task_images','202611030010_task_reviews','202611030011_task_review_conflicts','202611030012_task_notifications','202611030013_photo_optimization',
        '202611040001_unified_attendance','202611040003_attendance_live_updates','202611060001_password_reset_requests','202611060002_store_roles',
        '202611060004_isolate_attendance_by_store','202611060005_detach_super_admins_from_stores','202611060006_persist_business_store','202611060007_scope_attendance_operations']
    for name in original:
        db.execute((ROOT/'supabase/migrations'/(name+'.sql')).read_text(encoding='utf-8'))
    recent = sorted((ROOT/'supabase/migrations').glob('20261107*.sql'))
    for path in recent:
        if path.name != '202611070011_phase4_performance.sql':
            db.execute(path.read_text(encoding='utf-8'))
    db.execute(f"""insert into crm_stores(id,name) values('{SA}','Synthetic A'),('{SB}','Synthetic B');
      insert into auth.users(id) values('{A}'),('{C}'),('{B}');
      insert into profiles(id,employee_id,name,email,role,store_id) values
        ('{A}','QA1','Synthetic Employee A','a@example.test','employee','{SA}'),('{C}','QA2','Synthetic Employee C','c@example.test','employee','{SA}'),('{B}','QA3','Synthetic Employee B','b@example.test','employee','{SB}');
      insert into crm_datasets(id,owner_id,store_id,name,original_filename) values(1,'{A}','{SA}','West Synthetic','west.xlsx'),(2,'{B}','{SB}','Private','private.xlsx');
      insert into crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order) values(1,'Leads','Name','name',1),(1,'Leads','Phone','phone',2);
      insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data,response,callback_date,updated_at)
        select g,1,'Leads',g+1,jsonb_build_object('name','Synthetic '||g,'phone',lpad(g::text,10,'0'),'literal','100%_!'),'callback',date '2026-11-07'+g%3,timestamptz '2026-11-01Z'+g*interval '1 second' from generate_series(1,{SIZE}) g;
      insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data) values({SIZE+1},2,'Leads',2,'{{"name":"Private"}}');
      insert into crm_customer_record_changes(record_id,changed_by,previous_values,updated_values,changed_at)
        select 1,'{A}',jsonb_build_object('note','before '||g),jsonb_build_object('note',repeat('x',500)||g),timestamptz '2026-11-01Z'+(g/3)*interval '1 second' from generate_series(1,{SIZE}) g;
      insert into crm_visits(owner_id,store_id,customer_id,visit_date,meeting_time,location,expense,status,payment_status,total_amount,paid_amount,note,created_at)
        select case when g%2=0 then '{A}'::uuid else '{C}'::uuid end,'{SA}',g,date '2026-01-01'+g%300,time '10:00','Synthetic',0.10,
          case when g%5=0 then 'converted' else 'healthy' end,case when g%5=0 then 'completed' else 'not_paid' end,
          case when g%5=0 then 100.25 else 0 end,case when g%5=0 then 100.25 else 0 end,repeat('n',500),timestamptz '2026-01-01Z'+g*interval '1 second' from generate_series(1,{SIZE}) g;
      insert into crm_visits(owner_id,store_id,customer_id,visit_date,meeting_time,location) values('{B}','{SB}',{SIZE+1},'2026-12-31','10:00','Private');
      insert into crm_assigned_tasks(assignee_id,assigned_by_id,title,note,due_at,status,created_at)
        select '{A}','{C}','Task '||g,repeat('t',500),timestamptz '2026-11-01Z'+g*interval '1 hour',case when g%2=0 then 'done' else 'pending' end,timestamptz '2026-01-01Z'+g*interval '1 second' from generate_series(1,{SIZE}) g;
      insert into attendance_records(user_id,employee_id,employee_name,punch_code,punched_at,serial_number,status)
        select '{A}','QA1','Synthetic Employee A','001',timestamptz '2026-01-01Z'+g*interval '10 minute','QA-SYNTHETIC',case when g%2=0 then 'OUT' else 'IN' end from generate_series(1,{SIZE}) g;
      analyze;""")
    assert value(db,'select count(*) from crm_customer_records where dataset_id=1') == SIZE
    assert value(db,'select count(*) from crm_assigned_tasks') == SIZE
    assert value(db,'select count(*) from attendance_records') == SIZE
    history_sql = 'select * from crm_customer_record_changes where record_id=1 order by changed_at desc,id desc limit 50'
    sales_sql = 'select * from crm_visits where store_id=%s order by visit_date desc,meeting_time desc,created_at desc,id desc limit 5'
    explain(db,'historyBefore',history_sql)
    explain(db,'salesBefore',sales_sql,(SA,))
    explain(db,'salesReportBefore','select crm_sales_report(%s,null,\'2026-11-07\')',(SA,))
    reference_reports = [(scope,owner,value(db,'select crm_sales_report(%s,%s,\'2026-11-07\')',(scope,owner))) for scope in (SA,SB) for owner in (None,A,B)]
    for label, sql in [('history','select coalesce(jsonb_agg(to_jsonb(t)),\'[]\') from (select * from crm_customer_record_changes where record_id=1 order by changed_at desc,id desc) t'),('sales','select coalesce(jsonb_agg(to_jsonb(t)),\'[]\') from (select * from crm_visits where store_id=%s order by visit_date desc,meeting_time desc,created_at desc,id desc) t')]:
        rows = value(db,sql,(SA,) if label=='sales' else None)
        REPORT['payloads'][label+'Before'] = dict(rows=len(rows),jsonBytes=len(json.dumps(rows,separators=(',',':')).encode()))
    db.execute((ROOT/'supabase/migrations/202611070011_phase4_performance.sql').read_text(encoding='utf-8'))
    db.execute('analyze')
    for scope,owner,report in reference_reports:
        assert value(db,'select crm_sales_report(%s,%s,\'2026-11-07\')',(scope,owner)) == report, 'Report output changed'
    after_history=explain(db,'historyAfter',history_sql)
    after_sales=explain(db,'salesAfter',sales_sql,(SA,))
    assert 'crm_customer_history_page_idx' in json.dumps(after_history)
    assert 'crm_visits_store_page_idx' in json.dumps(after_sales)
    scenarios = [
      ('salesPageRpc','select crm_sales_visit_page(%s,null,\'{}\',1)',(SA,)),
      ('salesEmployeePageRpc','select crm_sales_visit_page(%s,%s,\'{}\',1)',(SA,A)),
      ('salesFilteredRpc','select crm_sales_visit_page(%s,null,%s,1)',(SA,Jsonb(dict(q='Synthetic 24',payment_status='completed')))),
      ('salesDeepPageRpc','select crm_sales_visit_page(%s,null,\'{}\',5000)',(SA,)),
      ('historyPageRpc','select crm_customer_history_page(1,null,null)',None),
      ('clientPageRpc',"select crm_sales_client_page(1,'',1,null)",None),
      ('clientFilteredRpc',"select crm_sales_client_page(1,'0000024999',1,null)",None),
      ('clientDeepPageRpc',"select crm_sales_client_page(1,'',500,null)",None),
      ('callbackPageRpc',"select crm_callback_page(array[1]::bigint[],'2026-11-07','2026-11-08',null,false,false,1)",None),
      ('callbackUnderlyingFirstPage',"select * from crm_customer_records where dataset_id=1 and response='callback' and callback_completed_at is null order by callback_date asc nulls last,updated_at asc,id asc limit 50",None),
      ('salesSummaryRpc','select crm_visit_summary(%s,null,\'2026-11-07\')',(SA,)),
      ('salesReportRpc','select crm_sales_report(%s,null,\'2026-11-07\')',(SA,)),
      ('tasksExistingFullList','select * from crm_assigned_tasks where assignee_id=%s order by status,due_at,created_at desc,id desc',(A,)),
      ('attendanceEmployeeMonth','select * from attendance_records where user_id=%s and punched_at>=\'2026-03-01Z\' and punched_at<\'2026-04-01Z\' order by punched_at desc',(A,)),
      ('attendanceStoreMonth','select a.* from attendance_records a join profiles p on p.id=a.user_id where p.store_id=%s and a.punched_at>=\'2026-03-01Z\' and a.punched_at<\'2026-04-01Z\' order by a.punched_at desc',(SA,)),
      ('attendanceStoreFullRead','select a.* from attendance_records a join profiles p on p.id=a.user_id where p.store_id=%s order by a.punched_at desc',(SA,))]
    for name,sql,params in scenarios:
        explain(db,name,sql,params)
    history=value(db,'select crm_customer_history_page(1,null,null)')
    sales=value(db,'select crm_sales_visit_page(%s,null,\'{}\',1)',(SA,))
    clients=value(db,"select crm_sales_client_page(1,'',1,null)")
    for label,result in [('history',history),('sales',sales),('clients',clients)]:
        REPORT['payloads'][label+'After']=dict(rows=len(result['records']),jsonBytes=len(json.dumps(result,separators=(',',':')).encode()))
    assert len(history['records'])==50 and history['nextCursor'] is not None
    assert sales['pagination']['count']==SIZE and len(sales['records'])==5
    assert len(clients['records'])==50 and clients['pagination']['hasMore'] is True
    assert value(db,'select crm_sales_visit_page(%s,%s,\'{}\',1)',(SA,B))['pagination']['count']==0
    callback=value(db,"select crm_callback_page(array[1]::bigint[],'2026-11-07','2026-11-08',null,false,false,1)")
    total=value(db,'select crm_visit_summary(%s,null,\'2026-11-07\')',(SA,))
    report=value(db,'select crm_sales_report(%s,null,\'2026-11-07\')',(SA,))
    assert callback['counts']['total']==SIZE and len(callback['records'])==50
    assert total['sales']['totalVisitExpenses']==2500 and total['payments']['totalAmount']==501250
    assert report['totalVisits']==SIZE and report['totalExpenses']==2500
    assert sum(m['count'] for m in report['recentMonths'])==value(db,"select count(*) from crm_visits where store_id=%s and visit_date>='2026-06-01' and visit_date<'2026-12-01'",(SA,))
    REPORT['assertions']=['25000 each: customer/callback, history, sales, task, attendance rows', 'History index used and cursor page bounded at 50', 'Sales ordered index used and page bounded at 5', 'Client lookup bounded at 50', 'Foreign owner sees no sales', 'SQL callback counts and exact financial sums reconcile']
    REPORT['appliedMigrations']=original+[p.stem for p in recent]
output=ROOT/'tmp/phase4/performance-native.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(REPORT,indent=2,default=str),encoding='utf-8')
print('PASS: native plans and integrity assertions; evidence '+str(output),flush=True)
