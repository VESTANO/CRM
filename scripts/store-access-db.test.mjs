import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

for (const scoped of [false, true]) test(`store feature migration preserves ${scoped ? 'selected-store' : 'existing live'} attendance behavior`, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key, encrypted_password text, updated_at timestamptz default now(), last_sign_in_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.role() returns text language sql stable as $$select 'authenticated'::text$$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb);
      create publication supabase_realtime;`);
    const originals = ['202611020001_crm_core', '202611020002_crm_legacy_import', '202611020003_crm_profile_service_role',
      '202611030001_visit_optional_meeting_fields', '202611030004_reminder_updated_at', '202611030005_reminder_delivery_receipts',
      '202611030009_task_images', '202611030010_task_reviews', '202611030011_task_review_conflicts', '202611030012_task_notifications', '202611030013_photo_optimization',
      '202611040001_unified_attendance', '202611040003_attendance_live_updates', '202611060001_password_reset_requests', '202611060002_store_roles',
      '202611060004_isolate_attendance_by_store', '202611060005_detach_super_admins_from_stores', '202611060006_persist_business_store', '202611060007_scope_attendance_operations'];
    for (const name of originals.filter(name => scoped || !['202611060006_persist_business_store', '202611060007_scope_attendance_operations'].includes(name))) {
      await db.exec(readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    const storeA = (await db.query('select id from crm_stores limit 1')).rows[0].id;
    const storeB = uid(22);
    await db.query('insert into crm_stores(id,name) values($1,$2)', [storeB, 'Second synthetic store']);
    for (const [n, role, store] of [[1, 'admin', storeA], [2, 'employee', storeA], [3, 'employee', storeB], [4, 'super_admin', null]]) {
      await db.query('insert into auth.users(id,encrypted_password) values($1,$2)', [uid(n), 'synthetic-preserved']);
      await db.query('insert into profiles(id,employee_id,name,email,role,store_id) values($1,$2,$3,$4,$5,$6)', [uid(n), `QA${n}`, `Employee ${n}`, `qa${n}@example.test`, role, store]);
    }
    for (const n of [2, 3]) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(n)]);
      await db.exec("select create_timesheet_entry('2026-11-07','Synthetic project','Work details','Project Work','09:00','18:00',1,true,'Completed','');");
    }
    await db.exec("insert into attendance_records(punch_code,punched_at,serial_number) values('UNMAPPED-QA','2026-11-07 09:00:00+00','SYNTHETIC')");
    const totalsFor = async (n) => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(n)]);
      return (await db.query(scoped ? 'select get_store_dashboard_totals($1::uuid) data' : 'select get_dashboard_totals() data', scoped ? [storeA] : [])).rows[0].data;
    };
    const oldTotals = [];
    for (const n of [1, 2, 4]) oldTotals.push(await totalsFor(n));
    for (const name of ['202611070100_store_contact_details', '202611070101_store_features', '202611070102_preserve_unmapped_attendance_access']) {
      await db.exec(readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    for (const [i, n] of [1, 2, 4].entries()) assert.deepEqual(await totalsFor(n), oldTotals[i], `unchanged totals for role ${n}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(4)]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*) n from attendance_records where user_id is null')).rows[0].n, 1, 'Super Admin still sees unmapped biometric punches');
    await db.exec('reset role');
    const before = (await db.query('select jsonb_agg(to_jsonb(t) order by id) data from timesheet_entries t')).rows[0].data;
    const credentials = (await db.query('select jsonb_agg(to_jsonb(t) order by id) data from auth.users t')).rows[0].data;
    const defaults = (await db.query('select features from crm_stores where id=$1', [storeA])).rows[0].features;
    assert.equal(Object.keys(defaults).length, 8);
    assert.ok(Object.values(defaults).every(Boolean));
    await db.query("update crm_stores set features=jsonb_set(features,'{attendance}','false') where id=$1", [storeA]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(1)]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*) n from timesheet_entries')).rows[0].n, 0);
    if (scoped) {
      await assert.rejects(db.query('select get_store_dashboard_totals($1::uuid)', [storeA]), /not enabled/);
      await assert.rejects(db.query('select get_store_dashboard_totals($1::uuid)', [storeB]), /not accessible/);
    } else {
      assert.equal((await db.query('select get_dashboard_totals() data')).rows[0].data.hours, 0);
      assert.equal((await db.query("select to_regprocedure('public.get_store_dashboard_totals(uuid)') id")).rows[0].id, null);
    }
    await assert.rejects(db.exec("update crm_stores set features='{}'"), /permission denied/);
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(2)]);
    await assert.rejects(db.exec("select create_timesheet_entry('2026-11-08','Synthetic','Details','Project Work','09:00','18:00',1,true,'Completed','')"), /not enabled/);
    await db.query("update crm_stores set features=jsonb_set(features,'{attendance}','true') where id=$1", [storeA]);
    await db.query('update profiles set active=false where id=$1', [uid(2)]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [uid(1)]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*) n from timesheet_entries')).rows[0].n, 1, 'inactive employee history stays visible to their Admin');
    await db.exec('reset role');
    assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(t) order by id) data from timesheet_entries t')).rows[0].data, before);
    assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(t) order by id) data from auth.users t')).rows[0].data, credentials);
    await assert.rejects(db.query("update crm_stores set features=jsonb_set(features,'{dashboard}','\"false\"') where id=$1", [storeA]), /check constraint/);
  } finally { await db.close(); }
});
