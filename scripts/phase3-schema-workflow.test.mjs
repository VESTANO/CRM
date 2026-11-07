import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { pg_trgm } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js';
const migrations=new URL('../supabase/migrations/',import.meta.url);
test('combined business-schema replay and import → callback → sales → report consistency',async()=>{
  const db=new PGlite({extensions:{pgcrypto,pg_trgm}});
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
      create table auth.users(id uuid primary key,encrypted_password text,updated_at timestamptz default now(),last_sign_in_at timestamptz,raw_app_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select 'authenticated'::text$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
      create publication supabase_realtime;`);
    const existing=['202611020001_crm_core','202611020002_crm_legacy_import','202611020003_crm_profile_service_role',
      '202611030001_visit_optional_meeting_fields','202611030004_reminder_updated_at','202611030005_reminder_delivery_receipts',
      '202611030009_task_images','202611030010_task_reviews','202611030011_task_review_conflicts','202611030012_task_notifications','202611030013_photo_optimization',
      '202611040001_unified_attendance','202611040003_attendance_live_updates','202611060001_password_reset_requests','202611060002_store_roles',
      '202611060004_isolate_attendance_by_store','202611060005_detach_super_admins_from_stores','202611060006_persist_business_store','202611060007_scope_attendance_operations'];
    for(const name of existing) await db.exec(readFileSync(new URL(name+'.sql',migrations),'utf8'));
    for(const name of readdirSync(migrations).filter(n=>n.startsWith('20261107')&&n.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(name,migrations),'utf8'));
    const actor='00000000-0000-4000-8000-000000000001',store=(await db.query('select id from crm_stores limit 1')).rows[0].id;
    await db.query('insert into auth.users(id) values($1)',[actor]);
    await db.query("insert into profiles(id,employee_id,name,email,role,store_id) values($1,'EMPQA','Synthetic employee','qa@example.test','employee',$2)",[actor,store]);
    const call=async(name,params)=>(await db.query(`select ${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) result`,params.map(p=>p&&typeof p==='object'?JSON.stringify(p):p))).rows[0].result;
    const sheets=[{name:'Leads',rows:1,expected_rows:1,column_names:['Name','Phone'],field_keys:['name','phone']}];
    const job=await call('crm_import',[actor,store,'start',null,{fingerprint:'f'.repeat(64),datasetName:'Integrated QA',filename:'qa.xlsx',sheets}]);
    await call('crm_import',[actor,store,'batch',job.id,{rows:[{sheet_name:'Leads',row_number:2,original_data:{name:'Synthetic Alice',phone:'0001234567'}}]}]);
    const committed=await call('crm_import',[actor,store,'commit',job.id,{}]);
    const record=(await db.query('select * from crm_customer_records where dataset_id=$1',[committed.dataset.id])).rows[0];
    await call('crm_update_customer',[actor,store,record.id,{response:'callback',callback_date:'2026-11-07',note:'Call today',expected_revision:0},false]);
    const queue=(await db.query("select crm_callback_page($1::bigint[],'2026-11-07','2026-11-08','2026-11-07',false,false,1) result",[[committed.dataset.id]])).rows[0].result;
    assert.equal(queue.counts.today,1);
    await call('crm_update_customer',[actor,store,record.id,{response:'converted',expected_revision:1},true]);
    const visit=await call('crm_save_sales_visit',[actor,store,null,{customer_id:record.id,visit_date:'2026-11-07',meeting_time:'10:00',location:'QA',expense:2.75,status:'converted',payment_status:'partially_paid',total_amount:100.25,paid_amount:30.10,payment_description:'Synthetic',note:'Integrated test'},null,[]]);
    assert.equal(visit.customer_id,record.id);
    const totals=await call('crm_visit_summary',[store,actor,'2026-11-07']);
    assert.equal(totals.payments.pendingAmount,70.15);assert.equal(totals.sales.totalVisits,1);
    const report=await call('crm_sales_report',[store,actor,'2026-11-07']);
    assert.equal(report.totalVisits,1);assert.equal(report.totalExpenses,2.75);assert.equal(report.recentMonths.at(-1).count,1);
    assert.equal((await db.query('select count(*) n from crm_customer_record_changes where record_id=$1',[record.id])).rows[0].n,2);
    assert.deepEqual((await db.query('select original_data from crm_customer_records where id=$1',[record.id])).rows[0].original_data,record.original_data);
    // Arrays use typed PostgreSQL parameters, unlike JSON payloads above.
    const completed=(await db.query("select crm_callback_page($1::bigint[],'2026-11-07','2026-11-08',null,true,false,1) result",[[committed.dataset.id]])).rows[0].result;
    assert.equal(completed.counts.total,0);assert.equal(completed.counts.calledBack,1);
  } finally {await db.close();}
});
