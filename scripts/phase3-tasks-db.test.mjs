import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const adminA=uid(1),employeeA=uid(2),adminB=uid(3),employeeB=uid(4),globalAdmin=uid(5),reviewerA=uid(6),a=uid(11),b=uid(12);
const sql=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
test('task evidence, review, notification and store-integrity workflow in PostgreSQL',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema storage;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create publication supabase_realtime;`);
    await db.exec(sql('202611020001_crm_core'));
    for(const name of ['202611030009_task_images','202611030010_task_reviews','202611030011_task_review_conflicts','202611030012_task_notifications','202611030013_photo_optimization']) await db.exec(sql(name));
    await db.exec(`create table crm_stores(id uuid primary key,name text);alter table profiles add column store_id uuid;
      insert into crm_stores values('${a}','A'),('${b}','B');
      insert into auth.users select x::uuid from unnest(array['${adminA}','${employeeA}','${adminB}','${employeeB}','${globalAdmin}','${reviewerA}']) x;
      insert into profiles(id,employee_id,name,email,role,store_id) values
      ('${adminA}','ADMINA','Admin A','admina@example.test','admin','${a}'),('${employeeA}','EMPA','Employee A','empa@example.test','employee','${a}'),
      ('${adminB}','ADMINB','Admin B','adminb@example.test','admin','${b}'),('${employeeB}','EMPB','Employee B','empb@example.test','employee','${b}'),
      ('${globalAdmin}','GLOBAL','Global','global@example.test','super_admin',null),('${reviewerA}','REVIEWA','Reviewer A','reviewa@example.test','admin','${a}');`);
    await db.exec(sql('202611070005_task_store_guards'));
    const photos=user=>[{storage_path:`${user}/${crypto.randomUUID()}.jpg`,thumbnail_path:`${user}/${crypto.randomUUID()}.jpg`,original_name:'synthetic.jpg',byte_size:128,thumbnail_byte_size:64,width:40,height:40}];
    const save=async(id,actor,stage,values,images=[])=>(await db.query('select crm_save_task_photos($1,$2,$3,$4,$5) result',[id,actor,stage,JSON.stringify(values),JSON.stringify(images)])).rows[0].result;
    const review=async(task,submission,actor,action,note='')=>(await db.query('select crm_review_task_submission($1,$2,$3,$4,$5) result',[task,submission,actor,action,note])).rows[0].result;
    let task,first,second;
    await t.test('foreign-store task assignment and employee admin actions leave no records',async()=>{
      await assert.rejects(save(null,adminA,'assignment',{assignee:employeeB,title:'Foreign'}),/store/);
      await assert.rejects(save(null,employeeA,'assignment',{assignee:employeeA,title:'Forbidden'}),/Administrator/);
      assert.equal((await db.query('select count(*) n from crm_assigned_tasks')).rows[0].n,0);
    });
    await t.test('assignment creates one task, evidence row and durable employee notification',async()=>{
      task=await save(null,adminA,'assignment',{assignee:employeeA,title:'Arrange display'},photos(adminA));
      assert.equal(task.status,'pending');
      assert.equal((await db.query("select count(*) n from crm_task_notifications where recipient_id=$1 and kind='assigned'",[employeeA])).rows[0].n,1);
    });
    await t.test('submission needs evidence and assignee identity; fallback notifications stay within store',async()=>{
      await assert.rejects(save(task.id,employeeA,'completion',{status:'submitted'}),/After photos/);
      await assert.rejects(save(task.id,employeeB,'completion',{status:'submitted'},photos(employeeB)),/store/);
      await db.query('update profiles set active=false where id=$1',[adminA]);
      const submitted=await save(task.id,employeeA,'completion',{status:'submitted',submission_note:'Work complete'},photos(employeeA));
      assert.equal(submitted.status,'submitted');
      first=(await db.query('select id from crm_task_submissions where task_id=$1',[task.id])).rows[0].id;
      const recipients=(await db.query("select recipient_id from crm_task_notifications where kind='submitted' order by recipient_id")).rows.map(r=>r.recipient_id);
      assert.deepEqual(recipients,[globalAdmin,reviewerA]);
      await assert.rejects(save(task.id,employeeA,'completion',{status:'submitted'},photos(employeeA)),/already submitted/);
      assert.equal((await db.query('select count(*) n from crm_task_submissions')).rows[0].n,1);
    });
    await t.test('only authorized store reviewers decide, with required feedback and exact submission',async()=>{
      await assert.rejects(review(task.id,first,adminB,'approve'),/store/);
      await assert.rejects(review(task.id,first,employeeA,'approve'),/Administrator/);
      await assert.rejects(review(task.id,first,reviewerA,'reject',' '),/rejection note/);
      await assert.rejects(review(task.id,first,adminA,'approve'),/Administrator/);
      assert.equal((await review(task.id,first,reviewerA,'reject','Rearrange the display')).status,'rejected');
      const alert=(await db.query("select message from crm_task_notifications where recipient_id=$1 and kind='rejected'",[employeeA])).rows[0];
      assert.match(alert.message,/Rearrange the display/);
      await assert.rejects(review(task.id,first,reviewerA,'approve'),/already been reviewed/);
    });
    await t.test('resubmission preserves history, rejects stale drafts and commits final approval notification once',async()=>{
      await assert.rejects(save(task.id,employeeA,'completion',{status:'submitted'},photos(employeeA)),/review has changed/);
      await assert.rejects(save(task.id,employeeA,'completion',{status:'submitted',previous_submission_id:first}),/After photos/);
      await save(task.id,employeeA,'completion',{status:'submitted',previous_submission_id:first,submission_note:'Corrected'},photos(employeeA));
      second=(await db.query('select max(id) id from crm_task_submissions')).rows[0].id;
      await assert.rejects(review(task.id,first,reviewerA,'approve'),/submission has changed/);
      assert.equal((await review(task.id,second,reviewerA,'approve')).status,'done');
      assert.deepEqual((await db.query('select status from crm_task_submissions order by id')).rows.map(r=>r.status),['rejected','approved']);
      await assert.rejects(review(task.id,second,reviewerA,'approve'),/already been reviewed/);
      assert.equal((await db.query("select count(*) n from crm_task_notifications where kind='approved'")).rows[0].n,1);
    });
    await t.test('notification failures roll assignment, evidence submission and review back together',async()=>{
      const failAlert="create function qa_fail_task_alert() returns trigger language plpgsql as $$begin raise exception 'Injected task alert failure';end$$;";
      const enable="create trigger qa_fail_task_alert before insert on crm_task_notifications for each row execute function qa_fail_task_alert();";
      const disable='drop trigger qa_fail_task_alert on crm_task_notifications';
      await db.exec(failAlert+enable);
      const initial=(await db.query('select count(*) n from crm_assigned_tasks')).rows[0].n;
      await assert.rejects(save(null,reviewerA,'assignment',{assignee:employeeA,title:'Rollback proof'},photos(reviewerA)),/Injected task alert failure/);
      assert.equal((await db.query('select count(*) n from crm_assigned_tasks')).rows[0].n,initial);
      await db.exec(disable);
      const another=await save(null,reviewerA,'assignment',{assignee:employeeA,title:'Rollback proof'},photos(reviewerA));
      await db.exec(enable);
      await assert.rejects(save(another.id,employeeA,'completion',{status:'submitted'},photos(employeeA)),/Injected task alert failure/);
      assert.equal((await db.query('select status from crm_assigned_tasks where id=$1',[another.id])).rows[0].status,'pending');
      assert.equal((await db.query('select count(*) n from crm_task_submissions where task_id=$1',[another.id])).rows[0].n,0);
      assert.equal((await db.query("select count(*) n from crm_task_images where task_id=$1 and stage='completion'",[another.id])).rows[0].n,0);
      await db.exec(disable);
      await save(another.id,employeeA,'completion',{status:'submitted'},photos(employeeA));
      const submission=(await db.query('select id from crm_task_submissions where task_id=$1',[another.id])).rows[0].id;
      await db.exec(enable);
      await assert.rejects(review(another.id,submission,reviewerA,'reject','Redo'),/Injected task alert failure/);
      assert.equal((await db.query('select status from crm_assigned_tasks where id=$1',[another.id])).rows[0].status,'submitted');
      const saved=(await db.query('select status,review_note from crm_task_submissions where id=$1',[submission])).rows[0];
      assert.deepEqual(saved,{status:'submitted',review_note:''});
      await db.exec(disable);
      assert.equal((await review(another.id,submission,reviewerA,'reject','Redo')).status,'rejected');
    });
    await t.test('RLS limits alerts to active recipient; browser roles cannot call private transactions',async()=>{
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[employeeB]);
      await db.exec('set role authenticated');
      try {
        assert.equal((await db.query('select count(*) n from crm_task_notifications')).rows[0].n,0);
        await assert.rejects(review(task.id,second,reviewerA,'approve'),/permission denied/);
        await assert.rejects(db.query('select * from crm_task_images'),/permission denied/);
      } finally {await db.exec('reset role');}
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[employeeA]);
      await db.exec('set role authenticated');
      try {assert.ok((await db.query('select count(*) n from crm_task_notifications')).rows[0].n>0);} finally {await db.exec('reset role');}
      await db.query('update profiles set active=false where id=$1',[employeeA]);
      await db.exec('set role authenticated');
      try {assert.equal((await db.query('select count(*) n from crm_task_notifications')).rows[0].n,0);} finally {await db.exec('reset role');}
      await db.exec('set role service_role');
      try {
        await assert.rejects(db.query("select crm_review_task_submission_internal($1,$2,$3,'approve','')",[task.id,second,reviewerA]),/permission denied/);
        await assert.rejects(db.query("select crm_save_task_photos_internal($1,$2,'completion','{}','[]')",[task.id,employeeA]),/permission denied/);
      } finally {await db.exec('reset role');}
    });
  } finally {await db.close();}
});
