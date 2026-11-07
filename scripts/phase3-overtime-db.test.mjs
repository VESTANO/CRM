import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const admin=uid(1),employee=uid(2),foreign=uid(3),globalAdmin=uid(4),a=uid(11),b=uid(12);
const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
test('overtime requests, verified punches, decisions and alerts are one scoped transaction',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
      create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    await db.exec(migration('202611020001_crm_core'));
    await db.exec(`create table crm_stores(id uuid primary key,name text);alter table profiles add column store_id uuid;
      alter table profiles add column shift_start_time time default '09:30';alter table profiles add column shift_end_time time default '17:30';
      create table attendance_records(id bigint generated always as identity,user_id uuid,punched_at timestamptz);
      insert into crm_stores values('${a}','A'),('${b}','B');
      insert into auth.users values('${admin}'),('${employee}'),('${foreign}'),('${globalAdmin}');
      insert into profiles(id,employee_id,name,email,role,store_id) values
      ('${admin}','ADMINA','Admin A','a@example.test','admin','${a}'),('${employee}','EMPA','Employee','e@example.test','employee','${a}'),
      ('${foreign}','ADMINB','Admin B','b@example.test','admin','${b}'),('${globalAdmin}','GLOBAL','Global','g@example.test','super_admin',null);`);
    await db.exec(migration('202611060006_persist_business_store'));
    await db.exec(migration('202611070008_atomic_overtime'));
    const write=async(id,action,values={},actor=employee,scope=a)=>(await db.query('select crm_write_overtime($1,$2,$3,$4,$5) result',[actor,scope,id,action,JSON.stringify(values)])).rows[0].result;
    const request={workDate:'2026-11-07',declaredLeaveTime:'2026-11-07T18:30:00+05:30'};
    const punches=async times=>{for(const time of times) await db.query('insert into attendance_records(user_id,punched_at) values($1,$2)',[employee,`2026-11-07T${time}+05:30`]);};
    let item;
    await t.test('wrong store, impossible day/time and mismatched working day make no writes',async()=>{
      await assert.rejects(write(null,'create',request,employee,b),/not accessible/);
      await assert.rejects(write(null,'create',request,globalAdmin,a),/store employee account/);
      await assert.rejects(write(null,'create',{...request,declaredLeaveTime:'2026-11-08T18:30:00+05:30'}),/selected working date/);
      await assert.rejects(write(null,'create',{...request,declaredLeaveTime:'2026-11-07T17:35:00+05:30'}),/after the official/);
      await assert.rejects(write(null,'create',{...request,workDate:'2026-02-30'}),/out of range/);
      assert.equal((await db.query('select count(*) n from crm_overtime_requests')).rows[0].n,0);
      assert.equal((await db.query('select count(*) n from crm_reminders')).rows[0].n,0);
    });
    await t.test('request before punch-out is allowed, with exactly one alert for scoped administrators',async()=>{
      item=await write(null,'create',request); assert.equal(item.requested_minutes,55); assert.equal(item.actual_punch_out,null);
      assert.deepEqual((await db.query('select owner_id,store_id from crm_reminders order by owner_id')).rows,[{owner_id:admin,store_id:a},{owner_id:globalAdmin,store_id:a}]);
      await assert.rejects(write(null,'create',request),/duplicate key/);
      assert.equal((await db.query('select count(*) n from crm_reminders')).rows[0].n,2);
      // Later shift edits must not redefine the cutoff captured by this request.
      await db.query("update profiles set shift_end_time='19:30' where id=$1",[employee]);
    });
    await t.test('foreign admins, employees, empty rejection and missing/open punches cannot approve',async()=>{
      await assert.rejects(write(item.id,'approve',{},foreign,b),/your store/);
      await assert.rejects(write(item.id,'approve',{},employee,a),/Administrator/);
      await assert.rejects(write(item.id,'reject',{message:' '},admin,a),/rejection reason/);
      await assert.rejects(write(item.id,'approve',{},admin,a),/final punch-out/);
      await punches(['09:30:00','13:00:00','14:00:00']);
      await assert.rejects(write(item.id,'approve',{},admin,a),/final punch-out/);
      assert.equal((await db.query('select status from crm_overtime_requests')).rows[0].status,'pending');
    });
    await t.test('alert failure rolls the decision back, preserving safe retry',async()=>{
      await punches(['18:10:00']);
      await db.exec("create function qa_fail_alert() returns trigger language plpgsql as $$begin raise exception 'Injected alert failure';end$$;create trigger qa_fail_alert before insert on crm_reminders for each row execute function qa_fail_alert();");
      await assert.rejects(write(item.id,'approve',{},admin,a),/Injected alert failure/);
      assert.equal((await db.query('select status from crm_overtime_requests')).rows[0].status,'pending');
      await db.exec('drop trigger qa_fail_alert on crm_reminders');
      const done=await write(item.id,'approve',{},admin,a);
      assert.equal(done.approved_minutes,35); assert.equal(done.status,'approved');
      await db.query("update profiles set shift_end_time='17:30' where id=$1",[employee]);
      await assert.rejects(write(item.id,'reject',{message:'Duplicate'},admin,a),/already been reviewed/);
      assert.equal((await db.query('select count(*) n from crm_reminders where owner_id=$1',[employee])).rows[0].n,1);
    });
    await t.test('request alert failure rolls back creation and direct browser RPC access is denied',async()=>{
      await db.exec("create trigger qa_fail_alert before insert on crm_reminders for each row execute function qa_fail_alert();");
      await assert.rejects(write(null,'create',{workDate:'2026-11-08',declaredLeaveTime:'2026-11-08T18:30:00+05:30'}),/Injected alert failure/);
      assert.equal((await db.query('select count(*) n from crm_overtime_requests')).rows[0].n,1);
      await db.exec('drop trigger qa_fail_alert on crm_reminders;set role authenticated');
      try {await assert.rejects(write(item.id,'approve',{},admin,a),/permission denied/);} finally {await db.exec('reset role');}
    });
    await t.test('long employee names and rejection feedback retain full business data while alerts stay bounded',async()=>{
      const name='Employee '.repeat(100),reason='Detailed rejection feedback. '.repeat(100);
      await db.query('update profiles set name=$1 where id=$2',[name,employee]);
      const next=await write(null,'create',{workDate:'2026-11-08',declaredLeaveTime:'2026-11-08T18:30:00+05:30'});
      const rejected=await write(next.id,'reject',{message:reason},globalAdmin,a);
      assert.equal(rejected.rejection_message,reason.trim());
      assert.equal(rejected.status,'rejected');
      assert.equal(rejected.reviewed_by,globalAdmin,'global Super Admin can still review the selected store');
      assert.equal((await db.query('select name from profiles where id=$1',[employee])).rows[0].name,name);
      assert.equal((await db.query('select max(length(text)) maximum from crm_reminders')).rows[0].maximum,500);
      assert.equal((await db.query('select count(*) n from crm_reminders where owner_id=$1',[employee])).rows[0].n,2);
    });
  } finally {await db.close();}
});
