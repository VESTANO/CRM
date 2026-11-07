"""Real PostgreSQL sessions; deliberately restricted to the disposable QA cluster.

Run: python scripts/phase4-concurrency.py
Requires installed psycopg and the separately initialized loopback QA cluster.
Creates a NEW database each run; never drops or connects to an application DB.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from time import perf_counter
import json
import uuid
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
CONFIG = dict(host="127.0.0.1", port=55483, user="phase4_qa", connect_timeout=5)
DATABASE = "crm_phase4_qa_" + uuid.uuid4().hex[:10]
REPORT = {"database": DATABASE, "transport": "127.0.0.1:55483", "scenarios": []}
def connect(database=DATABASE):
    c = psycopg.connect(**CONFIG, dbname=database, autocommit=True)
    c.execute("set statement_timeout='20s'")
    c.execute("set lock_timeout='10s'")
    return c
def query(c, sql, params=()):
    return c.execute(sql, params).fetchone()[0]
def rpc(c, name, *args):
    args = [Jsonb(v) if isinstance(v, (dict, list)) else v for v in args]
    return query(c, "select " + name + "(" + ",".join(["%s"]*len(args)) + ")", args)
def race(name, operations, successes, verify=None):
    barrier = Barrier(len(operations))
    def worker(operation):
        with connect() as c:
            pid = query(c, "select pg_backend_pid()")
            barrier.wait(timeout=10)
            start = perf_counter()
            try:
                with c.transaction():
                    result = operation(c)
                return dict(pid=pid, ok=True, result=result, ms=round((perf_counter()-start)*1000,2))
            except psycopg.Error as e:
                return dict(pid=pid, ok=False, code=e.sqlstate, message=e.diag.message_primary, ms=round((perf_counter()-start)*1000,2))
    with ThreadPoolExecutor(max_workers=len(operations)) as pool:
        results = list(pool.map(worker, operations))
    assert len({r['pid'] for r in results}) == len(results), "Not separate sessions"
    actual = sum(r['ok'] for r in results)
    assert actual in (successes if isinstance(successes,tuple) else (successes,)), (name, results)
    if verify:
        verify(results)
    REPORT["scenarios"].append(dict(name=name, sessions=len(results), results=results))
    print(name + ": PASS (" + str(actual) + "/" + str(len(results)) + " succeeded)", flush=True)
    return results
def uid(n):
    return str(uuid.UUID(int=n))
A, E, B, E2, G = [uid(n) for n in range(1,6)]
SA, SB = uid(11), uid(12)

with connect("postgres") as admin:
    assert query(admin, "select current_user") == 'phase4_qa'
    REPORT["server"] = query(admin,"select version()")
    admin.execute("create database " + DATABASE)
    admin.execute("""do $$begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
    end$$""")

with connect() as db:
    db.execute("""create schema auth;create schema storage;
      create table auth.users(id uuid primary key,encrypted_password text,updated_at timestamptz default now(),last_sign_in_at timestamptz,raw_app_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select 'authenticated'::text$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
      create publication supabase_realtime;""")
    existing = ['202611020001_crm_core','202611020002_crm_legacy_import','202611020003_crm_profile_service_role',
      '202611030001_visit_optional_meeting_fields','202611030004_reminder_updated_at','202611030005_reminder_delivery_receipts',
      '202611030009_task_images','202611030010_task_reviews','202611030011_task_review_conflicts','202611030012_task_notifications','202611030013_photo_optimization',
      '202611040001_unified_attendance','202611040003_attendance_live_updates','202611060001_password_reset_requests','202611060002_store_roles',
      '202611060004_isolate_attendance_by_store','202611060005_detach_super_admins_from_stores','202611060006_persist_business_store','202611060007_scope_attendance_operations']
    for name in existing:
        db.execute((ROOT / 'supabase/migrations' / (name+'.sql')).read_text(encoding='utf-8'))
    migrations = sorted((ROOT / 'supabase/migrations').glob('20261107*.sql'))
    for path in migrations:
        if path.name[:12] < '202611070012':
            db.execute(path.read_text(encoding='utf-8'))
    # Reuse actual claim SQL without installing cron, HTTP, Vault or a scheduler.
    claim = (ROOT/'supabase/migrations/202611030006_reminder_schedule_precision.sql').read_text(encoding='utf-8')
    db.execute(claim[claim.index('create or replace function public.claim_due_crm_reminders'):claim.index("select cron.schedule")])
    db.execute("insert into crm_stores(id,name) values(%s,'Synthetic A'),(%s,'Synthetic B')",(SA,SB))
    for actor, role, store in [(A,'admin',SA),(E,'employee',SA),(B,'admin',SB),(E2,'employee',SA),(G,'super_admin',None)]:
        db.execute('insert into auth.users(id) values(%s)',(actor,))
        db.execute("insert into profiles(id,employee_id,name,email,role,store_id) values(%s,%s,%s,%s,%s,%s)",(actor,'QA'+actor[-2:],'Synthetic '+actor[-2:],actor[-2:]+'@example.test',role,store))
    ds=query(db,"insert into crm_datasets(owner_id,store_id,name,original_filename) values(%s,%s,'Synthetic','qa.xlsx') returning id",(E,SA))
    record=query(db,"insert into crm_customer_records(dataset_id,sheet_name,row_number,original_data) values(%s,'Leads',2,'{\"name\":\"Synthetic\"}') returning id",(ds,))
    # Both users opened the SAME prior draft. Phase3 locks transactions, but did
    # not compare the version that each user actually edited.
    race('before fix: both stale customer drafts overwrite successfully',[
        lambda c: rpc(c,'crm_update_customer',A,SA,record,{'note':'Admin draft'},False),
        lambda c: rpc(c,'crm_update_customer',E,SA,record,{'note':'Employee draft'},False)],2)
    assert query(db,'select count(*) from crm_customer_record_changes where record_id=%s',(record,)) == 2
    for path in migrations:
        if path.name[:12] >= '202611070012':
            db.execute(path.read_text(encoding='utf-8'))
    def conflict(results):
        assert [r['code'] for r in results if not r['ok']] == ['PT409'], results
    race('after fix: stale customer draft rejected',[
        lambda c: rpc(c,'crm_update_customer',A,SA,record,{'note':'Admin new','expected_revision':0},False),
        lambda c: rpc(c,'crm_update_customer',E,SA,record,{'note':'Employee new','expected_revision':0},False)],1,conflict)
    assert query(db,'select revision from crm_customer_records where id=%s',(record,)) == 1
    assert query(db,'select count(*) from crm_customer_record_changes where record_id=%s',(record,)) == 3
    rpc(db,'crm_update_customer',E,SA,record,{'response':'callback','callback_date':'2026-11-07','expected_revision':1},False)
    race('simultaneous callback completion',[
        lambda c: rpc(c,'crm_update_customer',A,SA,record,{'response':'converted','expected_revision':2},True),
        lambda c: rpc(c,'crm_update_customer',E,SA,record,{'response':'interested','expected_revision':2},True)],1,conflict)
    fields=dict(customer_id=record,visit_date='2026-11-07',meeting_time='10:00',location='QA',expense=2.75,status='converted',payment_status='partially_paid',total_amount=100.25,paid_amount=30.10,note='Synthetic')
    key=str(uuid.uuid4())
    visits=race('same visit creation request replayed simultaneously',[
        lambda c: rpc(c,'crm_save_sales_visit',E,SA,None,{**fields,'request_key':key},None,[])]*6,6)
    visit=visits[0]['result']['id']
    assert {r['result']['id'] for r in visits} == {visit}
    assert query(db,'select count(*) from crm_visits') == 1
    race('concurrent financial edits compare captured revision',[
        lambda c: rpc(c,'crm_save_sales_visit',A,SA,visit,{**fields,'paid_amount':40.10,'expected_revision':0},None,[]),
        lambda c: rpc(c,'crm_save_sales_visit',E,SA,visit,{**fields,'paid_amount':50.10,'expected_revision':0},None,[])],1,conflict)
    total, paid=query(db,'select array[total_amount,paid_amount] from crm_visits where id=%s',(visit,))
    summary=rpc(db,'crm_visit_summary',SA,E,'2026-11-07')
    assert round(float(total-paid),2) == summary['payments']['pendingAmount']
    sheets=[dict(name='Leads',rows=1,expected_rows=1,column_names=['Name'],field_keys=['name'])]
    imports=race('same workbook import start',[
        lambda c: rpc(c,'crm_import',E,SA,'start',None,dict(fingerprint='e'*64,datasetName='Concurrent',filename='synthetic.xlsx',sheets=sheets))]*4,4)
    job=imports[0]['result']['id']
    assert {r['result']['id'] for r in imports} == {job}
    rpc(db,'crm_import',E,SA,'batch',job,{'rows':[dict(sheet_name='Leads',row_number=2,original_data={'name':'Synthetic import'})]})
    commits=race('same workbook import commit', [lambda c: rpc(c,'crm_import',E,SA,'commit',job,{})]*4,4)
    assert len({r['result']['dataset']['id'] for r in commits}) == 1
    assert query(db,'select count(*) from crm_datasets') == 2
    def photo(actor):
        return [dict(storage_path=actor+'/qa.jpg',thumbnail_path=actor+'/qa-thumb.jpg',original_name='qa.jpg',byte_size=128,thumbnail_byte_size=64,width=40,height=40)]
    task=rpc(db,'crm_save_task_photos',None,A,'assignment',{'assignee':E,'title':'Synthetic concurrent review'},photo(A))
    rpc(db,'crm_save_task_photos',task['id'],E,'completion',{'status':'submitted'},photo(E))
    submission=query(db,'select id from crm_task_submissions where task_id=%s',(task['id'],))
    race('two administrators review the same task',[
        lambda c: rpc(c,'crm_review_task_submission',task['id'],submission,A,'approve',''),
        lambda c: rpc(c,'crm_review_task_submission',task['id'],submission,G,'reject','Synthetic feedback')],1)
    assert query(db,"select count(*) from crm_task_notifications where task_id=%s and kind in ('approved','rejected')",(task['id'],)) == 1
    ot=rpc(db,'crm_write_overtime',E,SA,None,'create',dict(workDate='2026-11-07',declaredLeaveTime='2026-11-07T18:30:00+05:30'))
    for time in ['09:30','18:10']:
        db.execute("insert into attendance_records(user_id,punch_code,punched_at,serial_number) values(%s,'QA',%s,'QA')",(E,'2026-11-07T'+time+':00+05:30'))
    race('simultaneous overtime approvals',[
        lambda c: rpc(c,'crm_write_overtime',A,SA,ot['id'],'approve',{}),
        lambda c: rpc(c,'crm_write_overtime',G,SA,ot['id'],'approve',{})],1)
    assert query(db,'select approved_minutes from crm_overtime_requests where id=%s',(ot['id'],)) == 35
    race('password reset cooldown', [lambda c: rpc(c,'crm_claim_password_reset','d'*64)]*8,8,
         lambda results: REPORT.update(reset_claims=sum(r['result'] is True for r in results)))
    assert REPORT['reset_claims'] == 1
    db.execute("insert into crm_migration_authorizations(token_hash,expires_at) values(%s,now()+interval '1 hour')",('c'*64,))
    claims=race('one-time legacy migration claim',[lambda c: rpc(c,'crm_claim_legacy_migration','c'*64)]*8,8)
    assert sum(r['result'] is True for r in claims) == 1
    newcomer, legacy = uid(8), uid(9)
    for actor,role,store in [(newcomer,'super_admin',None),(legacy,'employee',SA)]:
        db.execute('insert into auth.users(id,encrypted_password) values(%s,\'Temporary\')',(actor,))
        db.execute("insert into profiles(id,employee_id,name,email,role,store_id) values(%s,%s,'Synthetic account',%s,%s,%s)",(actor,'QA'+actor[-2:],actor[-2:]+'@example.test',role,store))
    race('simultaneous first-store administration retains one immutable binding',[
        lambda c: query(c,"update profiles set role='admin',store_id=%s where id=%s returning store_id",(SA,newcomer)),
        lambda c: query(c,"update profiles set role='admin',store_id=%s where id=%s returning store_id",(SB,newcomer))],1)
    assert query(db,'select store_id=store_binding_id from profiles where id=%s',(newcomer,)) is True
    db.execute("insert into crm_legacy_auth(local_user_id,username,auth_email,password_hash,role,name,auth_user_id) values(9,'QA09','09@example.test','Synthetic retained hash','employee','Synthetic account',%s)",(legacy,))
    auth_race=race('password reset and in-flight legacy upgrade cannot restore old password',[
        lambda c: query(c,"update auth.users set encrypted_password='Reset-password' where id=%s returning encrypted_password",(legacy,)),
        lambda c: query(c,"update auth.users set encrypted_password='Old-password',raw_app_meta_data=jsonb_build_object('crm_legacy_password_upgrade',true) where id=%s returning encrypted_password",(legacy,))],(1,2))
    assert auth_race[0]['ok'] is True
    assert query(db,'select encrypted_password from auth.users where id=%s',(legacy,)) == 'Reset-password'
    assert query(db,'select password_hash from crm_legacy_auth where auth_user_id=%s',(legacy,)) is None
    assert query(db,"select not(raw_app_meta_data ? 'crm_legacy_password_upgrade') from auth.users where id=%s",(legacy,)) is True
    # OT generated future/due alerts too; remove none. Claim test uses all due
    # synthetic rows and asserts disjoint IDs across real overlapping workers.
    for n in range(100):
        db.execute("insert into crm_reminders(owner_id,store_id,text,reminder_at) values(%s,%s,%s,now()-interval '1 minute')",(E,SA,'Synthetic reminder '+str(n)))
    claims=race('simultaneous reminder workers skip locked rows',[lambda c: query(c,'select coalesce(jsonb_agg(id),\'[]\') from claim_due_crm_reminders(20)')]*8,8)
    claimed=[n for result in claims for n in result['result']]
    assert len(claimed) == len(set(claimed)) and len(claimed) >= 100
    attack=race('foreign store edits denied without financial or history changes',[
        lambda c: rpc(c,'crm_update_customer',B,SB,record,{'note':'Attack','expected_revision':3},False),
        lambda c: rpc(c,'crm_save_sales_visit',B,SB,visit,{**fields,'expected_revision':1},None,[])],0)
    assert all(r['code']=='42501' for r in attack)
    # Old clients fail explicitly; no server-side auto-refresh of a stale draft.
    try:
        rpc(db,'crm_update_customer',E,SA,record,{'note':'Missing revision'},False)
        raise AssertionError('Missing revision was accepted')
    except psycopg.Error as error:
        assert error.sqlstate == 'PT428'
    REPORT['integrity'] = dict(customers=query(db,'select count(*) from crm_customer_records'),visits=query(db,'select count(*) from crm_visits'),task_decisions=1,approved_ot_minutes=35,duplicate_reminder_claims=0)
    REPORT['applied_migrations'] = existing+[p.stem for p in migrations]
output=ROOT/'tmp/phase4-concurrency-results.json'
output.write_text(json.dumps(REPORT,indent=2,default=str),encoding='utf-8')
print('PASS: '+str(len(REPORT['scenarios']))+' scenarios; evidence '+str(output),flush=True)
