"""Local-only migration, historical-data and logical recovery rehearsal.

Creates NEW databases in the owned loopback QA cluster; never reads application
credentials or connects to a hosted/application database. Supabase-owned Auth
and Storage catalogs are explicit local prerequisites, not provider emulation.
Scheduler extensions/Vault are probed and classified BLOCKED when unavailable.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import sys
import time
import uuid
import psycopg
from psycopg import sql

ROOT=Path(__file__).resolve().parents[1]
MIGRATIONS=ROOT/'supabase/migrations'
BIN=Path('C:/Program Files/PostgreSQL/16/bin')
CONFIG=dict(host='127.0.0.1',port=55483,user='phase4_qa',connect_timeout=5)
SUFFIX=uuid.uuid4().hex[:10]
OUTPUT=ROOT/'tmp/phase5'/('migration-'+SUFFIX)
OUTPUT.mkdir(parents=True,exist_ok=True)
REPRODUCE='--reproduce' in sys.argv
HOSTED={'202611030002_reminder_dispatch.sql','202611030003_reminder_dispatch_auth.sql','202611030006_reminder_schedule_precision.sql'}
FILES=sorted(MIGRATIONS.glob('*.sql'))
ORIGINAL=[p for p in FILES if p.name<'202611070000' and p.name not in HOSTED]
PREPARED=[p for p in FILES if p.name>='202611070000' and (not REPRODUCE or p.name[:12]<='202611070012')]
ORIGINAL_002_SHA256='2746d2b33a2876d499c582f874490220444bce7c4a101f9bffe932060ff2c42e'
REPORT=dict(startedAt=datetime.now(timezone.utc).isoformat(),mode='baseline reproduction' if REPRODUCE else 'final migration rehearsal',databases=[],checks=[],manifest=[],limitations=[
    'Not a Supabase staging project or a copy of production records/schema drift',
    'Auth and Storage catalog prerequisites are local; actual provider permissions and ownership unverified',
    'pg_cron/pg_net/Vault and scheduler execution require actual hosted verification',
    'Logical database archive excludes Storage object bytes, Auth service/session state, project secrets and platform infrastructure',
    'No migration downgrade is supplied: failed-file rollback and restore-to-new-database are rehearsed instead'])

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),default=str).encode()).hexdigest()

def query(db,statement,params=None):
    return db.execute(statement,params).fetchone()[0]

def connect(database):
    db=psycopg.connect(**CONFIG,dbname=database,autocommit=True)
    db.execute("set statement_timeout='30s';set lock_timeout='5s'")
    return db

def new_database(label):
    name='crm_phase5_'+label+'_'+SUFFIX
    with connect('postgres') as admin:
        assert query(admin,'select current_user')=='phase4_qa'
        admin.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
    REPORT['databases'].append(name)
    return name

def bootstrap(db):
    db.execute("""create schema auth;create schema storage;
      create table auth.users(id uuid primary key,encrypted_password text,updated_at timestamptz default now(),last_sign_in_at timestamptz,raw_app_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
      grant usage on schema auth to anon,authenticated,service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated,service_role;
      grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
      create policy qa_preexisting_broad_storage on storage.objects for all to authenticated using(true) with check(true);
      create publication supabase_realtime;""")

def apply(db,paths):
    for path in paths:
        start=time.perf_counter()
        source=path.read_text(encoding='utf-8')
        if REPRODUCE and path.name=='202611070002_customer_query_performance.sql':
            source=source.replace('-- This derived-field backfill is not a customer edit. Preserve historical edit\n-- times and callback ordering. Only the timestamp trigger is suspended; all\n-- changes and re-enabling roll back together if any later statement fails.\n','')
            source=source.replace('alter table public.crm_customer_records disable trigger crm_customer_records_updated_at;\n','').replace('alter table public.crm_customer_records enable trigger crm_customer_records_updated_at;\n','')
            assert hashlib.sha256(source.encode()).hexdigest()==ORIGINAL_002_SHA256
        try: db.execute(source)
        except Exception:
            db.execute('rollback')
            raise
        REPORT.setdefault('applications',[]).append(dict(database=db.info.dbname,migration=path.name,appliedSqlSha256=hashlib.sha256(source.encode()).hexdigest(),ms=round((time.perf_counter()-start)*1000,3)))

def check(name,fn):
    start=time.perf_counter()
    try:
        detail=fn() or {}
        REPORT['checks'].append(dict(name=name,status='PASSED',ms=round((time.perf_counter()-start)*1000,2),detail=detail))
        print('PASSED '+name,flush=True)
    except Exception as error:
        REPORT['checks'].append(dict(name=name,status='FAILED',error=str(error),type=type(error).__name__))
        print('FAILED '+name+': '+str(error),flush=True)

def rows(db,table,remove=()):
    statement=sql.SQL("select coalesce(jsonb_agg(v order by v::text),'[]') from (select to_jsonb(t)-%s::text[] v from {} t) q").format(sql.Identifier(*table.split('.')))
    return query(db,statement,(list(remove),))

def snapshot(db,project_original=False):
    tables=[r[0] for r in db.execute("select schemaname||'.'||tablename from pg_tables where schemaname in ('public','auth','storage') order by 1").fetchall()]
    removed={'public.crm_customer_records':['search_name','revision'],'public.crm_visits':['revision'],'public.profiles':['store_binding_id']} if project_original else {}
    return {name:rows(db,name,removed.get(name,())) for name in tables}

def catalog(db):
    queries={
      'tables':"select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage') and c.relkind='r' order by 1,2",
      'constraints':"select n.nspname,c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage') order by 1,2,3",
      'indexes':"select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','auth','storage') order by 1,2,3",
      'policies':"select schemaname,tablename,policyname,permissive,roles::text,cmd,qual,with_check from pg_policies where schemaname in ('public','auth','storage') order by 1,2,3",
      'grants':"select table_schema,table_name,grantee,privilege_type,is_grantable from information_schema.role_table_grants where table_schema in ('public','auth','storage') order by 1,2,3,4",
      'functions':"select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,p.proconfig::text,pg_get_functiondef(p.oid),p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','storage') and p.prokind='f' order by 1,2,3",
      'triggers':"select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','auth','storage') order by 1,2,3",
      'sequences':"select schemaname,sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname='public' order by 1,2"}
    return {name:db.execute(statement).fetchall() for name,statement in queries.items()}

def expect_error(db,statement,params=None,code=None):
    try: db.execute(statement,params)
    except psycopg.Error as error:
        db.execute('rollback')
        if code: assert error.sqlstate==code,(error.sqlstate,str(error))
        return dict(sqlstate=error.sqlstate,message=error.diag.message_primary)
    raise AssertionError('Expected SQL failure was accepted')

def uid(n): return str(uuid.UUID(int=n))
A,E,B,EB,G,GP,L,R,S,I=[uid(n) for n in range(1,11)]
SB=uid(102)

def seed(db):
    sa=query(db,"select id from crm_stores where name='Vestano CRM'")
    db.execute('insert into crm_stores(id,name) values(%s,\'Synthetic B\')',(SB,))
    for actor,role,scope in [(A,'admin',sa),(E,'employee',sa),(B,'admin',SB),(EB,'employee',SB),(G,'super_admin',None),(GP,'employee',sa),(L,'employee',sa),(R,'employee',sa),(S,'employee',sa),(I,'employee',SB)]:
        db.execute("insert into auth.users(id,encrypted_password,updated_at,last_sign_in_at) values(%s,'Synthetic auth password','2026-10-01Z',%s)",(actor,'2026-10-03Z' if actor==S else None))
        db.execute('insert into profiles(id,employee_id,name,email,role,store_id,active) values(%s,%s,%s,%s,%s,%s,%s)',(actor,'QA'+actor[-2:],'Synthetic '+actor[-2:],actor[-2:]+'@example.test',role,scope,actor!=I))
    db.execute("update auth.users set updated_at='2026-10-03Z' where id=%s",(R,))
    for n,actor in enumerate([L,R,S],1):
        db.execute("insert into crm_legacy_auth(local_user_id,username,original_email,auth_email,password_hash,name,role,auth_user_id,created_at,updated_at) values(%s,%s,%s,%s,'Synthetic retained hash','Synthetic legacy','employee',%s,'2026-10-02Z','2026-10-02Z')",(n,'LEGACY'+str(n),'old'+str(n)+'@example.test',actor[-2:]+'@example.test',actor))
    db.execute("insert into crm_datasets(id,owner_id,store_id,name,original_filename,uploaded_at,updated_at) values(1,%s,%s,'Historical Leads','001-original.xlsx','2026-09-01Z','2026-09-02Z'),(2,%s,%s,'Private B','b.xlsx','2026-09-03Z','2026-09-04Z'),(3,%s,%s,'Promoted A history','promoted.xlsx','2026-09-05Z','2026-09-06Z')",(E,sa,EB,SB,GP,sa))
    db.execute("insert into crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order) values(1,'Leads','Customer Name','name',1),(1,'Leads','Phone','phone',2),(2,'Private','Name','name',1)")
    db.execute("""insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data,response,callback_date,note,created_at,updated_at) values
      (1,1,'Leads',2,'{"name":"Synthetic αlice","phone":"0001234567","custom":"exact\\nsource"}','callback','2026-11-07','Historical note','2026-09-01Z','2026-09-02 03:04:05Z'),
      (2,2,'Private',2,'{"name":"Private Bob"}','converted',null,'Private note','2026-09-03Z','2026-09-04Z');""")
    db.execute("insert into crm_customer_record_changes(record_id,changed_by,previous_values,updated_values,changed_at) values(1,%s,'{\"response\":\"interested\"}','{\"response\":\"callback\",\"note\":\"Historical note\"}','2026-09-02 03:04:05Z')",(E,))
    db.execute("insert into crm_manual_clients(id,owner_id,store_id,client_name,created_at,updated_at) values(1,%s,%s,'Historical manual','2026-09-01Z','2026-09-02Z')",(E,sa))
    db.execute("""insert into crm_visits(id,owner_id,store_id,customer_id,manual_client_id,visit_date,meeting_time,location,expense,status,payment_status,total_amount,paid_amount,note,created_at,updated_at) values
      (1,%s,%s,1,null,'2026-10-01',null,'',2.75,'converted','partially_paid',100.25,30.10,'Historical receivable','2026-09-01Z','2026-09-02Z'),
      (2,%s,%s,null,1,'2026-10-02','10:00','QA',1.25,'healthy','partially_paid',100,150,'Old-schema overpayment','2026-09-03Z','2026-09-04Z'),
      (3,%s,%s,2,null,'2026-10-03','11:00','B',5,'converted','completed',75,75,'Private','2026-09-05Z','2026-09-06Z');""",(E,sa,E,sa,EB,SB))
    db.execute("insert into crm_visit_images(visit_id,storage_path,original_name,thumbnail_path,byte_size,thumbnail_byte_size,width,height) values(1,%s,'historical.jpg',%s,1000,100,600,400)",(E+'/historical.jpg',E+'/historical-thumb.jpg'))
    db.execute("insert into crm_assigned_tasks(id,assignee_id,assigned_by_id,title,note,due_at,status,created_at,updated_at) values(1,%s,%s,'Historical task','Keep this','2026-10-01Z','pending','2026-09-01Z','2026-09-02Z')",(E,A))
    db.execute("insert into crm_task_images(task_id,stage,storage_path,original_name) values(1,'assignment',%s,'historical-task.jpg')",(A+'/historical-task.jpg',))
    db.execute("insert into crm_sales_targets(user_id,month,target) values(%s,'2026-10-01',10)",(E,))
    db.execute("insert into crm_overtime_requests(employee_id,work_date,assigned_start_time,assigned_end_time,official_end_time,declared_leave_time,requested_minutes) values(%s,'2026-10-01','09:30','18:30','17:30','2026-10-01 13:00Z',30)",(E,))
    for actor,employee in [(E,'E'),(EB,'EB'),(G,'GLOBAL'),(I,'INACTIVE')]:
        db.execute("insert into timesheet_entries(user_id,employee_id,employee_name,work_date,project,details,category,start_time,end_time,total_hours) values(%s,%s,'Synthetic','2026-10-01','Historical','Keep exact','General','09:30','17:30',8)",(actor,employee))
        db.execute("insert into attendance_records(user_id,employee_id,employee_name,punch_code,punched_at,serial_number,status,raw) values(%s,%s,'Synthetic',%s,'2026-10-01 04:00Z','QA-SYNTHETIC','IN','Exact historical source')",(actor,employee,employee))
    db.execute("insert into attendance_mappings(punch_code,user_id) values('E',%s),('EB',%s)",(E,EB))
    db.execute("insert into attendance_devices(serial_number,model,last_ingest_route) values('QA-SYNTHETIC','Synthetic','direct')")
    db.execute("update profiles set role='super_admin',store_id=null where id=%s",(GP,))
    db.execute("insert into crm_reminders(owner_id,store_id,text,reminder_at,delivery_status) values(%s,%s,'Historical reminder','2026-10-01Z','retrying')",(E,sa))
    db.execute("update storage.buckets set public=true where id in ('crm-task-images','crm-visit-images')")
    db.execute("insert into storage.buckets(id,name,public) values('unrelated','Unrelated',true)")
    db.execute("insert into storage.objects(bucket_id,name,owner,metadata) values('crm-visit-images',%s,%s,'{\"synthetic\":true}'),('unrelated','kept.txt',%s,'{}')",(E+'/historical.jpg',E,E))
    return str(sa)

def dump(database,path):
    command=[str(BIN/'pg_dump.exe'),'--host=127.0.0.1','--port=55483','--username=phase4_qa','--format=custom','--file='+str(path),'--dbname='+database]
    start=time.perf_counter();result=subprocess.run(command,capture_output=True,text=True,timeout=60)
    assert result.returncode==0,result.stderr
    return dict(bytes=path.stat().st_size,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),elapsedMs=round((time.perf_counter()-start)*1000,3),stderr=result.stderr.strip())

def restore(database,path):
    command=[str(BIN/'pg_restore.exe'),'--host=127.0.0.1','--port=55483','--username=phase4_qa','--exit-on-error','--no-owner','--dbname='+database,str(path)]
    start=time.perf_counter();result=subprocess.run(command,capture_output=True,text=True,timeout=60)
    assert result.returncode==0,result.stderr
    REPORT.setdefault('restores',[]).append(dict(database=database,archive=str(path),elapsedMs=round((time.perf_counter()-start)*1000,3)))

try:
    with connect('postgres') as admin:
        REPORT['server']=query(admin,'select version()')
        admin.execute("""do $$begin
          if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
          if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
          if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
        end$$""")
    def inventory():
        versions=[p.name.split('_',1)[0] for p in FILES]
        assert len(set(versions))==len(versions)
        assert [p.name[:12] for p in PREPARED if p.name[:12]<='202611070012']==['20261107'+str(n).zfill(4) for n in range(1,13)]
        REPORT['manifest']=[dict(file=p.name,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),bytes=p.stat().st_size,localBusinessReplay=p.name not in HOSTED,transactional=p.read_text(encoding='utf-8').lstrip().startswith('begin;') or '\nbegin;' in p.read_text(encoding='utf-8')[:250]) for p in FILES]
        return dict(files=len(FILES),prepared=len(PREPARED),duplicateVersions=0,hostedInfrastructure=sorted(HOSTED))
    check('unique ordered migration inventory',inventory)
    fresh_name=new_database('fresh')
    with connect(fresh_name) as fresh:
        bootstrap(fresh)
        def dependencies():
            available=dict(fresh.execute("select name,default_version from pg_available_extensions where name in ('pgcrypto','pg_trgm','pg_cron','pg_net','supabase_vault')").fetchall())
            REPORT['providerDependencies']=dict(available=available,missing=[n for n in ['pg_cron','pg_net','supabase_vault'] if n not in available],vaultCatalogExists=query(fresh,"select to_regclass('vault.decrypted_secrets') is not null"))
            return REPORT['providerDependencies']
        check('probe actual extension and Vault prerequisites',dependencies)
        if REPORT['providerDependencies']['missing']:
            REPORT['checks'].append(dict(name='complete hosted scheduler/HTTP/Vault migration replay',status='BLOCKED',reason='Native QA lacks '+', '.join(REPORT['providerDependencies']['missing'])+'; no scheduler substitutes installed'))
        def fresh_replay():
            apply(fresh,ORIGINAL);apply(fresh,PREPARED)
            assert query(fresh,"select count(*) from pg_index where not indisvalid or not indisready")==0
            assert query(fresh,"select count(*) from pg_constraint where connamespace='public'::regnamespace and not convalidated")==0
            assert query(fresh,"select to_regclass('public.crm_native_reminder_devices') is null")
            return dict(originalBusinessMigrations=len(ORIGINAL),prepared=len(PREPARED),validIndexes=True,validatedConstraints=True)
        check('fresh native business-schema migration replay',fresh_replay)
    upgrade_name=new_database('upgrade')
    with connect(upgrade_name) as db:
        bootstrap(db);apply(db,ORIGINAL);sa=seed(db)
        def preflight():
            before_preflight=snapshot(db);before_schema=catalog(db)
            cursor=db.execute((ROOT/'scripts/phase5-migration-preflight.sql').read_text(encoding='utf-8'))
            selected=0
            while True:
                if cursor.description:
                    cursor.fetchall();selected+=1
                if not cursor.nextset(): break
            assert snapshot(db)==before_preflight and catalog(db)==before_schema,'Read-only preflight changed state'
            return dict(selectResults=selected,dataAndCatalogUnchanged=True)
        check('read-only release preflight executes without changing data or catalogs',preflight)
        before=snapshot(db);before_catalog=catalog(db)
        pre_dump=OUTPUT/'pre-upgrade.dump';REPORT['preUpgradeBackup']=dump(upgrade_name,pre_dump)
        apply(db,PREPARED)
        def preservation():
            after=snapshot(db,True)
            protected={name:value for name,value in before.items() if name not in ['public.crm_legacy_auth','storage.buckets']}
            differences=[name for name,value in protected.items() if after.get(name)!=value]
            REPORT['dataPreservation']=dict(beforeFingerprints={n:digest(v) for n,v in protected.items()},afterFingerprints={n:digest(after.get(n)) for n in protected},differences=differences)
            if REPRODUCE:
                assert differences==['public.crm_customer_records'],differences
                REPORT['baselineTimestampBug']=dict(rowsChanged=len(before['public.crm_customer_records']),originalTimestamp=before['public.crm_customer_records'][0]['updated_at'],changedTimestamp=after['public.crm_customer_records'][0]['updated_at'],migration='202611070002_customer_query_performance.sql')
            else: assert differences==[],differences
            assert after['public.crm_customer_records'][0]['original_data']==before['public.crm_customer_records'][0]['original_data']
            assert rows(db,'public.crm_customer_record_changes')==before['public.crm_customer_record_changes']
            assert all(r['revision']==0 for r in rows(db,'public.crm_customer_records'))
            assert all(r['revision']==0 for r in rows(db,'public.crm_visits'))
            return dict(protectedTables=len(protected),differences=differences,originalFieldsAndHistoryExact=True)
        check('historical row fingerprints, timestamps, original fields and history preservation',preservation)
        def intentional_changes():
            hashes=db.execute('select auth_user_id,password_hash is null from crm_legacy_auth order by local_user_id').fetchall()
            assert hashes==[(uuid.UUID(L),False),(uuid.UUID(R),True),(uuid.UUID(S),True)],hashes
            assert query(db,'select store_binding_id from profiles where id=%s',(GP,))==uuid.UUID(sa)
            assert query(db,'select store_binding_id is null from profiles where id=%s',(G,))
            assert query(db,"select bool_and(not public) from storage.buckets where id in ('crm-task-images','crm-visit-images')")
            assert query(db,"select public from storage.buckets where id='unrelated'")
            after_legacy=rows(db,'public.crm_legacy_auth')
            omit={'password_hash','password_upgraded_at','updated_at'}
            legacy_before=[{k:v for k,v in row.items() if k not in omit} for row in before['public.crm_legacy_auth']]
            legacy_after=[{k:v for k,v in row.items() if k not in omit} for row in after_legacy]
            assert sorted(legacy_before,key=lambda r:r['local_user_id'])==sorted(legacy_after,key=lambda r:r['local_user_id'])
            expected_buckets=[dict(row,public=False) if row['id'] in ['crm-task-images','crm-visit-images'] else row for row in before['storage.buckets']]
            assert sorted(expected_buckets,key=lambda r:r['id'])==sorted(rows(db,'storage.buckets'),key=lambda r:r['id'])
            REPORT['intentionalDataChanges']=dict(legacyIdentityBefore=digest(sorted(legacy_before,key=lambda r:r['local_user_id'])),legacyIdentityAfter=digest(sorted(legacy_after,key=lambda r:r['local_user_id'])),storageExpected=digest(sorted(expected_buckets,key=lambda r:r['id'])),storageActual=digest(sorted(rows(db,'storage.buckets'),key=lambda r:r['id'])))
            return dict(retainedFreshLegacyHashes=1,revokedStaleLegacyHashes=2,promotedBindingRecovered=True,unresolvedGlobalBlocked=True,crmBucketsPrivate=True)
        check('intentional security backfills preserve ownership and unrelated data',intentional_changes)
        def financial():
            summary=query(db,"select crm_visit_summary(%s,null,'2026-11-07')",(sa,))
            individual=query(db,'select sum(greatest(total_amount-paid_amount,0)) from crm_visits where store_id=%s',(sa,))
            REPORT['historicalFinance']=dict(summaryPending=summary['payments']['pendingAmount'],sumOfVisitPending=str(individual),overpaidRows=query(db,'select count(*) from crm_visits where paid_amount>total_amount'))
            if REPRODUCE: assert str(summary['payments']['pendingAmount'])=='20.15' and str(individual)=='70.15'
            else: assert str(summary['payments']['pendingAmount'])==str(individual)
            return REPORT['historicalFinance']
        check('historical overpayment cannot offset another visit receivable',financial)
        def negative_access():
            result={}
            for role in ['anon','authenticated']:
                db.execute('set role '+role)
                try:
                    result[role]=expect_error(db,'select * from crm_customer_record_changes',code='42501')
                    expect_error(db,"select crm_sales_visit_page(%s,null,'{}',1)",(sa,),code='42501')
                    expect_error(db,"select crm_visit_summary(%s,null,'2026-11-07')",(sa,),code='42501')
                finally: db.execute('reset role')
            db.execute("select set_config('request.jwt.claim.sub',%s,false)",(A,));db.execute('set role authenticated')
            try:
                visible=[str(r[0]) for r in db.execute('select distinct user_id from attendance_records').fetchall()]
                assert visible==[E],visible
                assert query(db,"select count(*) from storage.objects where bucket_id='crm-visit-images'")==0
                assert query(db,"select count(*) from storage.objects where bucket_id='unrelated'")==1
            finally: db.execute('reset role')
            expect_error(db,'update profiles set store_id=%s,role=\'employee\' where id=%s',(SB,GP),code='23514')
            expect_error(db,'update profiles set store_id=%s,role=\'employee\' where id=%s',(sa,G),code='23514')
            return dict(browserPrivateTablesAndRPCsDenied=True,storeAttendanceIsolated=True,preexistingBroadStoragePolicyRestricted=True)
        check('upgrade retains RLS, service-only grants, Storage restrictions and immutable bindings',negative_access)
        post=snapshot(db);post_catalog=catalog(db)
        post_dump=OUTPUT/'post-upgrade.dump';REPORT['postUpgradeBackup']=dump(upgrade_name,post_dump)
    def recovery():
        restored_name=new_database('restore')
        restore(restored_name,post_dump)
        with connect(restored_name) as restored:
            restored_data=snapshot(restored);restored_catalog=catalog(restored)
            assert restored_data==post,'Restored data differs'
            differences=[name for name,value in post_catalog.items() if restored_catalog.get(name)!=value]
            assert differences==[],differences
            REPORT['recovery']=dict(dataFingerprint=digest(post),restoredDataFingerprint=digest(restored_data),rowCounts={n:len(v) for n,v in post.items()},restoredRowCounts={n:len(v) for n,v in restored_data.items()},catalogFingerprints={n:digest(v) for n,v in post_catalog.items()},restoredCatalogFingerprints={n:digest(v) for n,v in restored_catalog.items()},catalogCounts={n:len(v) for n,v in post_catalog.items()},protectedTables=len(post),catalogCategories=list(post_catalog))
            return dict(database=restored_name,dataExact=True,constraintsIndexesRLSPoliciesGrantsFunctionsTriggersSequencesExact=True)
    check('native pg_dump custom archive and pg_restore preserve data plus security catalogs',recovery)
    def rollback_and_conflicts():
        failure_name=new_database('failure');restore(failure_name,pre_dump)
        with connect(failure_name) as broken:
            assert snapshot(broken)==before,'Pre-upgrade recovery rows differ'
            assert catalog(broken)==before_catalog,'Pre-upgrade recovery security/catalog differs'
            REPORT['preUpgradeRecovery']=dict(dataFingerprint=digest(before),restoredDataFingerprint=digest(snapshot(broken)),catalogFingerprint=digest(before_catalog),restoredCatalogFingerprint=digest(catalog(broken)))
            apply(broken,PREPARED[:4])
            broken.execute('alter function crm_notify_task_submission() rename to qa_drifted_task_notification')
            before_failure=catalog(broken)
            error=expect_error(broken,(MIGRATIONS/'202611070005_task_store_guards.sql').read_text(encoding='utf-8'))
            assert catalog(broken)==before_failure,'Failed migration left partial wrappers/grants'
            assert query(broken,"select to_regprocedure('crm_save_task_photos_internal(bigint,uuid,text,jsonb,jsonb)') is null")
            return dict(injectedDrift=error,failedMigrationRolledBackExactly=True)
    check('drift fails closed and migration005 rolls back prior renames/grants',rollback_and_conflicts)
    def backfill_rollback():
        failure_name=new_database('backfill');restore(failure_name,pre_dump)
        with connect(failure_name) as broken:
            apply(broken,[MIGRATIONS/'202611070001_atomic_customer_import.sql'])
            before_failure=catalog(broken);before_data=snapshot(broken)
            source=(MIGRATIONS/'202611070002_customer_query_performance.sql').read_text(encoding='utf-8')
            enable='alter table public.crm_customer_records enable trigger crm_customer_records_updated_at;'
            assert enable in source
            source=source.replace(enable,'select 1/0;\n'+enable,1)
            error=expect_error(broken,source,code='22012')
            assert catalog(broken)==before_failure,'Timestamp trigger/backfill DDL not rolled back'
            assert snapshot(broken)==before_data,'Failed backfill changed historical rows'
            assert query(broken,"select tgenabled from pg_trigger where tgrelid='crm_customer_records'::regclass and tgname='crm_customer_records_updated_at'")=='O'
            return dict(injectedFailure=error,triggerReenabledByRollback=True,dataAndCatalogExact=True)
    check('derived-field backfill failure restores the timestamp trigger and all historical rows',backfill_rollback)
    def duplicate_migration():
        with connect(fresh_name) as fresh:
            before_duplicate=catalog(fresh)
            error=expect_error(fresh,(MIGRATIONS/'202611070001_atomic_customer_import.sql').read_text(encoding='utf-8'),code='42P07')
            assert catalog(fresh)==before_duplicate
            return dict(error=error,ledgerRequired=True,replayOfAppliedMigrationRejectedWithoutDrift=True)
    check('duplicate prepared migration is rejected atomically; migration ledger required',duplicate_migration)
except Exception as error:
    REPORT['checks'].append(dict(name='rehearsal setup/execution',status='FAILED',type=type(error).__name__,error=str(error)))
    print('FAILED setup/execution '+str(error),flush=True)
finally:
    REPORT['finishedAt']=datetime.now(timezone.utc).isoformat()
    REPORT['counts']={status:sum(c['status']==status for c in REPORT['checks']) for status in ['PASSED','FAILED','BLOCKED']}
    path=OUTPUT/'results.json';path.write_text(json.dumps(REPORT,indent=2,default=str),encoding='utf-8')
    latest=ROOT/'tmp/phase5'/('migration-baseline.json' if REPRODUCE else 'migration-results.json')
    latest.write_text(json.dumps(REPORT,indent=2,default=str),encoding='utf-8')
    print(str(REPORT['counts'])+' evidence '+str(path),flush=True)
sys.exit(1 if REPORT['counts']['FAILED'] else 0)
