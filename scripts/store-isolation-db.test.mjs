import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Optional local PostgreSQL runtime; never connects to the hosted database.
// npm install --prefix tmp/store-isolation-db-test --no-save --no-package-lock @electric-sql/pglite
const { PGlite } = await import("../frontend/node_modules/@electric-sql/pglite/dist/index.js");
const a = "84c3cf98-35f6-45ee-a440-edc154e93851", b = "763e96b0-d47d-43fc-b86c-ef49c73ba559";
const adminA = "00000000-0000-4000-8000-000000000001", employeeA = "00000000-0000-4000-8000-000000000002";
const adminB = "00000000-0000-4000-8000-000000000003", employeeB = "00000000-0000-4000-8000-000000000004", superAdmin = "00000000-0000-4000-8000-000000000005";
const entryA = "00000000-0000-4000-8000-000000000011", entryB = "00000000-0000-4000-8000-000000000012";

test("PostgreSQL enforces durable store ownership, RLS, totals, approvals, and punch-code boundaries", async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select 'authenticated'::text $$;
      grant usage on schema auth to authenticated,service_role;
      create table public.crm_stores(id uuid primary key,name text);
      create table public.profiles(id uuid primary key,store_id uuid,employee_id text,name text,email text,role text,active boolean default true);
      create table public.crm_datasets(id integer primary key,owner_id uuid,name text,uploaded_at timestamptz default now());
      create table public.crm_manual_clients(id integer primary key,owner_id uuid,name text);
      create table public.crm_visits(id integer primary key,owner_id uuid,name text,visit_date date default current_date);
      create table public.crm_reminders(id integer primary key,owner_id uuid,name text);
      create table public.timesheet_entries(id uuid primary key,user_id uuid,work_date date,total_hours numeric,overtime numeric,billable boolean,approval_status text,approval_comment text,approved_by text,approved_at timestamptz);
      create table public.attendance_devices(serial_number text primary key);
      create table public.attendance_mappings(punch_code text primary key,user_id uuid,updated_at timestamptz default now());
      create table public.attendance_records(id uuid primary key,user_id uuid,punch_code text,employee_id text,employee_name text);
      alter table public.profiles enable row level security;
      alter table public.timesheet_entries enable row level security;
      alter table public.attendance_records enable row level security;
      create function public.current_user_role() returns text language sql stable security definer set search_path=public,pg_temp as $$ select role from profiles where id=auth.uid() and active $$;
      insert into public.crm_stores values ('${a}','Vestano CRM'),('${b}','Store B');
      insert into public.profiles(id,store_id,employee_id,name,role) values
        ('${adminA}','${a}','ADMINA','Admin A','admin'),('${employeeA}','${a}','EMPA','Employee A','employee'),
        ('${adminB}','${b}','ADMINB','Admin B','admin'),('${employeeB}','${b}','EMPB','Employee B','employee'),
        ('${superAdmin}',null,'SUPER','Global Super Admin','super_admin');
      insert into public.crm_datasets(id,owner_id,name) values (1,'${adminA}','Vestano original'),(2,'${adminB}','Other store original');
      insert into public.crm_manual_clients values (1,'${adminA}','Client A'),(2,'${adminB}','Client B');
      insert into public.crm_visits(id,owner_id,name) values (1,'${adminA}','Visit A'),(2,'${adminB}','Visit B');
      insert into public.crm_reminders values (1,'${adminA}','Reminder A'),(2,'${superAdmin}','Personal global reminder');
      insert into public.timesheet_entries(id,user_id,work_date,total_hours,overtime,billable,approval_status) values
        ('${entryA}','${employeeA}',current_date,8,1,true,'Submitted'),('${entryB}','${employeeB}',current_date,16,2,true,'Submitted');
      insert into public.attendance_records values ('${entryA}','${employeeA}','A','EMPA','Employee A'),('${entryB}','${employeeB}','B','EMPB','Employee B');
      insert into public.attendance_mappings(punch_code,user_id) values ('A','${employeeA}'),('B','${employeeB}');
    `);
    await db.exec(`create function public.crm_set_updated_at() returns trigger language plpgsql as $$begin new.updated_at:=now();return new;end$$;`);
    for (const table of ['crm_datasets','crm_visits','crm_manual_clients','crm_reminders']) {
      await db.exec(`alter table ${table} add column updated_at timestamptz not null default '2026-01-01T00:00:00Z';
        create trigger ${table}_updated_at before update on ${table} for each row execute function crm_set_updated_at();`);
    }
    for (const migration of ["202611060004_isolate_attendance_by_store.sql", "202611060006_persist_business_store.sql", "202611060007_scope_attendance_operations.sql"]) {
      await db.exec(readFileSync(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    }
    const actor = id => db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);

    await t.test("backfill preserves every original record and assigns only its existing owner's store", async () => {
      for (const table of ["crm_datasets", "crm_visits", "crm_manual_clients"]) {
        const result = await db.query(`select id,store_id from public.${table} order by id`);
        assert.deepEqual(result.rows, [{ id: 1, store_id: a }, { id: 2, store_id: b }]);
      }
      assert.equal((await db.query("select name from crm_datasets where id=1")).rows[0].name, "Vestano original");
      assert.equal((await db.query("select store_id from crm_reminders where id=2")).rows[0].store_id, null);
      for (const table of ['crm_datasets','crm_visits','crm_manual_clients','crm_reminders']) {
        assert.equal(Number((await db.query(`select count(*) n from ${table} where updated_at<>'2026-01-01T00:00:00Z'`)).rows[0].n),0,'ownership backfill preserves edit times');
      }
    });

    await t.test("records cannot transfer stores and global creators must choose a store", async () => {
      await assert.rejects(db.query("update crm_datasets set store_id=$1 where id=1", [b]), /original store/);
      await assert.rejects(db.query("insert into crm_datasets(id,owner_id,name,store_id) values(3,$1,'Invalid',$2)", [adminA, b]), /same store/);
      await assert.rejects(db.query("insert into crm_datasets(id,owner_id,name) values(3,$1,'Missing store')", [superAdmin]), /Select a store/);
      await db.query("insert into crm_datasets(id,owner_id,name,store_id) values(3,$1,'Super Admin created in Vestano',$2)", [superAdmin, a]);
      assert.equal((await db.query("select store_id from crm_datasets where id=3")).rows[0].store_id, a);
    });

    await t.test("totals are isolated for store admins and selected-store Super Admin views", async () => {
      await actor(adminA);
      assert.equal(Number((await db.query("select get_dashboard_totals() as totals")).rows[0].totals.hours), 8);
      await assert.rejects(db.query("select get_store_dashboard_totals($1)", [b]), /not accessible/);
      await actor(superAdmin);
      assert.equal(Number((await db.query("select get_store_dashboard_totals($1) as totals", [a])).rows[0].totals.hours), 8);
      assert.equal(Number((await db.query("select get_store_dashboard_totals($1) as totals", [b])).rows[0].totals.hours), 16);
      await assert.rejects(db.query("select get_dashboard_totals()"), /Open a store/);
    });

    await t.test("an admin cannot approve an entry in another store even through the direct RPC", async () => {
      await actor(adminA);
      await assert.rejects(db.query("select review_timesheet_entry($1,'Approved','test')", [entryB]), /not found in your store/);
      assert.equal((await db.query("select approval_status from timesheet_entries where id=$1", [entryB])).rows[0].approval_status, "Submitted");
      await db.query("select review_timesheet_entry($1,'Approved','test')", [entryA]);
      assert.equal((await db.query("select approval_status from timesheet_entries where id=$1", [entryA])).rows[0].approval_status, "Approved");
    });

    await t.test("existing biometric codes cannot move punches into a different store", async () => {
      await actor(adminA);
      await assert.rejects(db.query("select map_attendance_employee('B',$1)", [employeeA]), /Only Super Admins/);
      await actor(superAdmin);
      await assert.rejects(db.query("select map_attendance_employee('B',$1)", [employeeA]), /another store/);
      assert.equal((await db.query("select user_id from attendance_records where punch_code='B'")).rows[0].user_id, employeeB);
    });

    await t.test("RLS exposes only the caller's store profiles, timesheets, and attendance records", async () => {
      await actor(adminA);
      await db.exec("grant select on profiles,timesheet_entries,attendance_records to authenticated; set role authenticated;");
      try {
        assert.deepEqual((await db.query("select employee_id from profiles order by employee_id")).rows.map(row => row.employee_id), ["ADMINA", "EMPA"]);
        assert.deepEqual((await db.query("select user_id from attendance_records")).rows.map(row => row.user_id), [employeeA]);
        assert.deepEqual((await db.query("select user_id from timesheet_entries")).rows.map(row => row.user_id), [employeeA]);
      } finally { await db.exec("reset role"); }
    });
    await t.test('release retains the published totals RPC and denies disabled attendance in the selected-store RPC', async () => {
      await db.exec(`alter table crm_stores add column features jsonb default '{"attendance":true}';`);
      const featureSql=readFileSync(new URL('../supabase/migrations/202611070101_store_features.sql',import.meta.url),'utf8');
      const featureStart=featureSql.indexOf('create or replace function public.store_feature_enabled_for_user');
      await db.exec(featureSql.slice(featureStart,featureSql.indexOf('-- Direct Supabase reads',featureStart)));
      await db.exec(readFileSync(new URL('../supabase/migrations/202611070103_release_attendance_compatibility.sql',import.meta.url),'utf8'));
      await actor(superAdmin);
      assert.equal(Number((await db.query('select get_dashboard_totals() totals')).rows[0].totals.hours),24);
      assert.equal(Number((await db.query('select get_store_dashboard_totals($1) totals',[a])).rows[0].totals.hours),8);
      await db.query(`update crm_stores set features='{"attendance":false}' where id=$1`,[b]);
      await assert.rejects(db.query('select get_store_dashboard_totals($1)',[b]),/not enabled/);
      await actor(adminB);
      assert.equal(Number((await db.query('select get_dashboard_totals() totals')).rows[0].totals.hours),0);
      await assert.rejects(db.query('select get_store_dashboard_totals($1)',[b]),/not enabled/);
    });
  } finally { await db.close(); }
});
