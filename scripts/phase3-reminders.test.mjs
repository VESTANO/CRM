import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
test('PostgreSQL reminder schedules, claims and receipts reject stale/duplicate work',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema storage;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    await db.exec(migration('202611020001_crm_core'));
    await db.exec(migration('202611030004_reminder_updated_at'));
    await db.exec(migration('202611030005_reminder_delivery_receipts'));
    const dispatch=migration('202611030006_reminder_schedule_precision');
    // Execute the original claim function and its grants; pg_cron/pg_net jobs
    // require hosted infrastructure, so no scheduler or HTTP call runs here.
    await db.exec(dispatch.slice(dispatch.indexOf('create or replace function public.claim_due_crm_reminders('),dispatch.indexOf("select cron.schedule(")));
    await db.exec("insert into auth.users values('00000000-0000-4000-8000-000000000001'); insert into crm_reminders(id,owner_id,text,reminder_at) values(1,'00000000-0000-4000-8000-000000000001','Due',now()-interval '1 minute'),(2,'00000000-0000-4000-8000-000000000001','Upcoming',now()+interval '1 day');");
    await t.test('only due schedules are claimed; immediate retry does not duplicate a locked delivery',async()=>{
      assert.deepEqual((await db.query('select id from claim_due_crm_reminders(20)')).rows,[{id:1}]);
      assert.equal((await db.query('select * from claim_due_crm_reminders(20)')).rows.length,0);
      assert.equal((await db.query('select delivery_attempt_count from crm_reminders where id=1')).rows[0].delivery_attempt_count,1);
    });
    await t.test('rescheduling creates a new revision and resets prior delivery state',async()=>{
      await db.exec("update crm_reminders set sent_at=now(),delivery_status='sent' where id=1;update crm_reminders set reminder_at=now()+interval '1 day' where id=1;");
      const r=(await db.query('select delivery_revision,sent_at,delivery_status,delivery_attempt_count,delivery_locked_at from crm_reminders where id=1')).rows[0];
      assert.equal(Number(r.delivery_revision),2);assert.equal(r.sent_at,null);assert.equal(r.delivery_status,'pending');assert.equal(r.delivery_attempt_count,0);assert.equal(r.delivery_locked_at,null);
    });
    await t.test('old revisions and expired/invalid receipts cannot acknowledge a new schedule',async()=>{
      await db.exec("insert into crm_reminder_deliveries(reminder_id,endpoint_hash,delivery_revision,receipt_token_hash,receipt_expires_at) values(1,'old',1,'old-token',now()+interval '1 hour'),(1,'expired',2,'expired-token',now()-interval '1 hour'),(1,'new',2,'new-token',now()+interval '1 hour');");
      for(const [token,event] of [['old-token','displayed'],['expired-token','received'],['new-token','other'],['unknown','received']])assert.equal((await db.query('select record_crm_reminder_receipt($1,$2) accepted',[token,event])).rows[0].accepted,false);
      assert.equal((await db.query("select count(*) n from crm_reminder_deliveries where received_at is not null")).rows[0].n,0);
    });
    await t.test('valid receipt acknowledgment is idempotent and retains the first timestamps',async()=>{
      assert.equal((await db.query("select record_crm_reminder_receipt('new-token','clicked') accepted")).rows[0].accepted,true);
      const before=(await db.query("select received_at,displayed_at,clicked_at from crm_reminder_deliveries where receipt_token_hash='new-token'")).rows[0];
      assert.ok(before.received_at&&before.displayed_at&&before.clicked_at);
      await db.query("select record_crm_reminder_receipt('new-token','clicked')");
      assert.deepEqual((await db.query("select received_at,displayed_at,clicked_at from crm_reminder_deliveries where receipt_token_hash='new-token'")).rows[0],before);
    });
    await t.test('browser roles cannot claim work or forge database delivery receipts',async()=>{
      await db.exec('set role authenticated');
      try {
        await assert.rejects(db.query('select * from claim_due_crm_reminders(20)'),/permission denied/);
        await assert.rejects(db.query("select record_crm_reminder_receipt('new-token','clicked')"),/permission denied/);
      } finally {await db.exec('reset role');}
    });
  } finally {await db.close();}
});
