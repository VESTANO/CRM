import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PGlite} from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import {pgcrypto} from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const admin='00000000-0000-4000-8000-000000000001',employee='00000000-0000-4000-8000-000000000002',foreign='00000000-0000-4000-8000-000000000003',inactive='00000000-0000-4000-8000-000000000004';
const storeA='00000000-0000-4000-8000-000000000011',storeB='00000000-0000-4000-8000-000000000012';
const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
async function setup(){
  const db=new PGlite({extensions:{pgcrypto}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
    grant usage on schema auth to authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(migration('202611020001_crm_core'));
  await db.exec(`create table crm_stores(id uuid primary key,name text);alter table profiles add column store_id uuid references crm_stores;
    insert into auth.users values('${admin}'),('${employee}'),('${foreign}'),('${inactive}');
    insert into crm_stores values('${storeA}','A'),('${storeB}','B');
    insert into profiles(id,employee_id,name,email,role,store_id,active) values
      ('${admin}','ADMIN-A','Admin A','admin-a@example.test','admin','${storeA}',true),
      ('${employee}','EMP-A','Employee A','emp-a@example.test','employee','${storeA}',true),
      ('${foreign}','ADMIN-B','Admin B','admin-b@example.test','admin','${storeB}',true),
      ('${inactive}','INACTIVE','Inactive','inactive@example.test','employee','${storeA}',false);`);
  for(const name of ['202611040001_unified_attendance','202611060004_isolate_attendance_by_store','202611060007_scope_attendance_operations','202611100001_validate_timesheet_work_period'])await db.exec(migration(name));
  return db;
}
const identity=(db,id)=>db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
const create=async db=>(await db.query("select * from create_timesheet_entry(current_date,'Display','Arrange display','Project Work','09:00','18:00',0.5,true,'Completed','QA')" )).rows[0];
const review=(db,id,status,reason)=>db.query('select * from review_timesheet_entry($1,$2,$3)',[id,status,reason]);

test('timesheet submission, rejection, resubmission and final approval preserve audit and store boundaries',async t=>{
  const db=await setup();
  try{
    await db.exec('set role authenticated');await identity(db,employee);
    const historical=await create(db);
    await identity(db,admin);
    await t.test('reproduces original empty-feedback rejection and overwritable decision before the fix',async()=>{
      await review(db,historical.id,'Rejected','');
      assert.equal((await db.query('select approval_comment from timesheet_entries where id=$1',[historical.id])).rows[0].approval_comment,'');
      await review(db,historical.id,'Approved','Overwrites rejection');
      assert.equal((await db.query('select approval_status from timesheet_entries where id=$1',[historical.id])).rows[0].approval_status,'Approved');
    });
    await t.test('invalid work periods are rejected instead of being stored as zero-hour entries',async()=>{
      await identity(db,employee);
      await assert.rejects(db.query("select * from create_timesheet_entry(current_date,'Invalid','End precedes start','Project Work','11:00','05:30',0,false,'Completed','')"),/End time must be later than start time/);
      await assert.rejects(db.query("select * from create_timesheet_entry(current_date,'Invalid','Break consumes period','Project Work','10:00','10:42',1,false,'Completed','')"),/Break hours must be shorter than the work period/);
    });
    await db.exec('reset role');await db.exec(migration('202611070004_timesheet_decision_integrity'));await db.exec('set role authenticated');
    await identity(db,employee);const entry=await create(db);
    await t.test('a submitted work entry stores database-calculated totals and rejects invalid/unauthorized operations',async()=>{
      assert.equal(Number(entry.total_hours),8.5);assert.equal(Number(entry.overtime),0.5);assert.equal(entry.approval_status,'Submitted');
      await assert.rejects(review(db,entry.id,'Approved',''),/Only admins/);
      await identity(db,inactive);await assert.rejects(create(db),/Active employee/);
      await identity(db,foreign);await assert.rejects(review(db,entry.id,'Approved',''),/not found in your store/);
      assert.equal((await db.query('select id from timesheet_entries where id=$1',[entry.id])).rows.length,0,'foreign admin cannot read the row through RLS');
      await identity(db,admin);
      await assert.rejects(review(db,entry.id,'Rejected','   '),/feedback is required/);
      await assert.rejects(review(db,entry.id,'Submitted','reset'),/Choose Approved or Rejected/);
      assert.equal((await db.query('select approval_status from timesheet_entries where id=$1',[entry.id])).rows[0].approval_status,'Submitted');
    });
    await t.test('rejection saves a trimmed reason and duplicate decisions cannot replace its audit',async()=>{
      const rejected=(await review(db,entry.id,'Rejected',' Correct the work date ')).rows[0];
      assert.equal(rejected.approval_comment,'Correct the work date');assert.equal(rejected.approved_by,'Admin A');
      await assert.rejects(review(db,entry.id,'Approved','Changed decision'),/already been reviewed/);
      await assert.rejects(review(db,entry.id,'Rejected','Another reason'),/already been reviewed/);
      const saved=(await db.query('select approval_comment,approved_by,approved_at from timesheet_entries where id=$1',[entry.id])).rows[0];
      assert.equal(saved.approval_comment,rejected.approval_comment);assert.deepEqual(saved.approved_at,rejected.approved_at);
    });
    await t.test('employee edit resubmits rejected work, approval becomes immutable to the employee',async()=>{
      await identity(db,employee);
      const updated=(await db.query("select * from update_timesheet_entry($1,current_date,'Display','Corrected display','Project Work','09:30','17:30',0.5,true,'Completed','Corrected')",[entry.id])).rows[0];
      assert.equal(updated.approval_status,'Submitted');assert.equal(updated.approval_comment,'');assert.equal(updated.approved_at,null);
      await identity(db,admin);const approved=(await review(db,entry.id,'Approved','Accepted')).rows[0];
      assert.equal(approved.approval_status,'Approved');
      await identity(db,employee);
      await assert.rejects(db.query("select update_timesheet_entry($1,current_date,'Display','Overwrite','Project Work','09:30','17:30',0.5,true,'Completed','')",[entry.id]),/cannot be edited/);
      await assert.rejects(db.query('select delete_timesheet_entry($1)',[entry.id]),/cannot be deleted/);
      await assert.rejects(db.query("update timesheet_entries set approval_status='Approved' where id=$1",[entry.id]),/permission denied/);
    });
    await t.test('anonymous callers cannot invoke review; an owned unapproved draft can be deleted',async()=>{
      await db.exec('reset role;set role anon');await assert.rejects(review(db,entry.id,'Approved',''),/permission denied/);
      await db.exec('reset role;set role authenticated');await identity(db,employee);
      const disposable=await create(db);assert.equal((await db.query('select delete_timesheet_entry($1) deleted',[disposable.id])).rows[0].deleted,true);
      assert.equal((await db.query('select id from timesheet_entries where id=$1',[disposable.id])).rows.length,0);
    });
  }finally{await db.close();}
});
