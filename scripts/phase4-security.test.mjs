import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { pbkdf2Sync } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { pg_trgm } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js';

const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/crm-api/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
const password='Old-synthetic-password-1!';
const hash=`pbkdf2_sha256$1000$qa-salt$${pbkdf2Sync(password,'qa-salt',1000,32,'sha256').toString('base64')}`;

async function schema() {
  const db=new PGlite({extensions:{pgcrypto,pg_trgm}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,encrypted_password text,updated_at timestamptz default now(),last_sign_in_at timestamptz,raw_app_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text,owner uuid,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
    create publication supabase_realtime;`);
  const originals=['202611020001_crm_core','202611020002_crm_legacy_import','202611020003_crm_profile_service_role',
    '202611030001_visit_optional_meeting_fields','202611030004_reminder_updated_at','202611030005_reminder_delivery_receipts',
    '202611030009_task_images','202611030010_task_reviews','202611030011_task_review_conflicts','202611030012_task_notifications','202611030013_photo_optimization',
    '202611040001_unified_attendance','202611040003_attendance_live_updates','202611060001_password_reset_requests','202611060002_store_roles',
    '202611060004_isolate_attendance_by_store','202611060005_detach_super_admins_from_stores','202611060006_persist_business_store','202611060007_scope_attendance_operations',
    '202611070001_atomic_customer_import','202611070002_customer_query_performance','202611070003_dashboard_callbacks',
    '202611070004_timesheet_decision_integrity','202611070005_task_store_guards','202611070006_customer_integrity',
    '202611070007_atomic_sales_visit','202611070008_atomic_overtime','202611070009_atomic_password_reset_cooldown'];
  for(const migration of originals) await db.exec(sql(migration));
  return db;
}
async function account(db,n,{active=true,authChanged=false,signedIn=false,role='employee',store=null}={}) {
  const id=uid(n),email=`employee${n}@example.test`;
  store??=(await db.query('select id from crm_stores order by id limit 1')).rows[0].id;
  await db.query('insert into auth.users(id,encrypted_password,updated_at,last_sign_in_at) values($1,$2,$3,$4)',
    [id,'Temporary-password',authChanged?'2026-11-06T00:00:00Z':'2026-11-01T00:00:00Z',signedIn?'2026-11-06T00:00:00Z':null]);
  await db.query('insert into profiles(id,employee_id,name,email,role,active,store_id) values($1,$2,$3,$4,$5,$6,$7)',
    [id,`EMP${n}`,`Synthetic ${n}`,email,role,active,role==='super_admin'?null:store]);
  await db.query(`insert into crm_legacy_auth(local_user_id,username,original_email,auth_email,password_hash,role,name,auth_user_id,created_at)
    values($1,$2,$3,$3,$4,$5,$6,$7,'2026-11-02T00:00:00Z')`,[n,`EMP${n}`,email,hash,role,`Synthetic ${n}`,id]);
  return {id,email,store};
}

// Execute the actual Edge functions against a real disposable SQL database.
// Auth is a deterministic adapter: its password write updates auth.users and
// therefore executes the real revocation trigger. It is not hosted Auth proof.
function handlers(db,{wrongSessionUser=false,failMigrationReads=false,resetBeforeUpgrade=false}={}) {
  const authWrites=[],providerCalls=[];
  const adminClient={
    rpc:async(name,args)=>{
      try {
        if(name==='crm_legacy_login_account') {
          const result=await db.query('select crm_legacy_login_account($1) account',[args.p_identity]);
          return {data:result.rows.map(row=>row.account),error:null};
        }
        if(name==='crm_claim_legacy_migration') {
          const result=await db.query('select crm_claim_legacy_migration($1) claimed',[args.p_token_hash]);
          return {data:result.rows[0].claimed,error:null};
        }
        throw new Error(`Unexpected RPC ${name}`);
      } catch(error) { return {data:null,error}; }
    },
    auth:{admin:{
      updateUserById:async(id,values)=>{
        authWrites.push({id,...values});
        if(resetBeforeUpgrade)await db.query("update auth.users set encrypted_password='Concurrent-reset-password',updated_at=now() where id=$1",[id]);
        try {
          if(values.password) await db.query("update auth.users set encrypted_password=$1,raw_app_meta_data=raw_app_meta_data||$2::jsonb,updated_at=now() where id=$3",[values.password,JSON.stringify(values.app_metadata||{}),id]);
          return {data:{user:{id}},error:null};
        } catch(error) {return {data:null,error};}
      },
      listUsers:async()=>{if(failMigrationReads)throw new Error('Injected provider read failure');return {data:{users:[]},error:null};},
    },signInWithPassword:async({email,password:provided})=>{
      providerCalls.push(email);
      const {rows}=await db.query('select p.id,u.encrypted_password from profiles p join auth.users u on u.id=p.id where p.email=$1',[email]);
      if(rows.length!==1||rows[0].encrypted_password!==provided)return {data:{},error:{message:'Invalid credentials'}};
      const id=wrongSessionUser?uid(999):rows[0].id;
      return {data:{user:{id},session:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',user:{id}}},error:null};
    }},
    from:table=>{
      assert.ok(['profiles','crm_legacy_auth','crm_stores'].includes(table));
      const filters=[];let values,duplicateLookup=false;
      const execute=async()=>{
        if(duplicateLookup)return {data:[],error:null};
        const params=filters.map(([,value])=>value);
        const where=filters.length?' where '+filters.map(([key],i)=>`${key}=$${i+1}`).join(' and '):'';
        if(values) {
          const updates=Object.entries(values);
          const set=updates.map(([key],i)=>`${key}=$${params.length+i+1}`).join(',');
          await db.query(`update ${table} set ${set}${where}`,[...params,...updates.map(([,value])=>value)]);
        }
        return {data:(await db.query(`select * from ${table}${where}`,params)).rows,error:null};
      };
      const q={select:()=>q,eq:(key,value)=>{assert.match(key,/^[a-z_]+$/);filters.push([key,value]);return q;},
        neq:()=>q,or:()=>{duplicateLookup=true;return q;},
        maybeSingle:async()=>{const result=await execute();return {...result,data:result.data[0]||null};},
        single:async()=>{const result=await execute();return {...result,data:result.data[0]||null};},
        update:payload=>{values=payload;return q;},then:(yes,no)=>execute().then(yes,no)};
      return q;
    },
  };
  const api=new Function('createClient','Deno','corsHeaders',`${source};profileWithCounts=async p=>p;syncAttendanceAdmin=async()=>{};return {handleLegacyLogin,migrateLegacyData,handleAdmin};`)(
    ()=>adminClient,{env:{get:name=>name==='SUPABASE_ANON_KEY'?'synthetic-key':''},serve:()=>{}},{});
  const request=new Request('http://127.0.0.1/crm-api/auth/legacy-login',{method:'POST',headers:{apikey:'synthetic-key'}});
  return {authWrites,providerCalls,
    login:(identity,provided=password)=>api.handleLegacyLogin(request,{identity,password:provided}),
    admin:(id,body)=>api.handleAdmin({user:{id:uid(999)},profile:{role:'super_admin'}},'PATCH',['admin','users',id],new URLSearchParams(),body),
    migrate:(token,body)=>api.migrateLegacyData(new Request('http://127.0.0.1/crm-api/migration/import',{method:'POST',headers:{'x-crm-migration-token':token}}),body)};
}

test('Phase 4 actual SQL/handler security, legacy credential revocation and privilege inventory',async t=>{
  const db=await schema();
  try {
    const fresh=await account(db,1),stale=await account(db,2,{authChanged:true}),used=await account(db,3,{signedIn:true});
    const knownGlobal=await account(db,20,{role:'super_admin'}),unresolvedGlobal=await account(db,21,{role:'super_admin'});
    await db.query("insert into crm_datasets(owner_id,store_id,name,original_filename) values($1,$2,'Historical','synthetic.xlsx')",[knownGlobal.id,knownGlobal.store]);
    await db.query("insert into attendance_records(serial_number,punch_code,user_id,punched_at) values('qa','21',$1,now())",[unresolvedGlobal.id]);
    await db.exec(sql('202611070010_phase4_security'));
    await db.exec(sql('202611070011_phase4_performance'));
    await db.exec(sql('202611070012_optimistic_concurrency'));
    await db.exec(sql('202611070104_native_login_compatibility'));

    await t.test('migration preserves existing passwords; sign-in and metadata timestamps do not prove a password change',async()=>{
      const rows=(await db.query('select auth_user_id,password_hash from crm_legacy_auth order by local_user_id')).rows;
      assert.equal(rows.find(row=>row.auth_user_id===fresh.id).password_hash,hash);
      assert.equal(rows.find(row=>row.auth_user_id===stale.id).password_hash,hash);
      assert.equal(rows.find(row=>row.auth_user_id===used.id).password_hash,hash);
    });

    await t.test('root cause reproduction: absent trigger, old imported password replaces a reset password',async()=>{
      const victim=await account(db,4);const app=handlers(db);
      await db.exec('alter table auth.users disable trigger crm_revoke_legacy_password');
      try {
        await db.query("update auth.users set encrypted_password='New-reset-password',updated_at=now() where id=$1",[victim.id]);
        assert.equal((await app.login('EMP4')).status,200);
        assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[victim.id])).rows[0].encrypted_password,password);
      } finally {await db.exec('alter table auth.users enable trigger crm_revoke_legacy_password');}
    });

    await t.test('all provider password writes revoke old hashes before the next login, and preserve the new password',async()=>{
      const victim=await account(db,5),app=handlers(db);
      await db.query("update auth.users set encrypted_password='New-reset-password',updated_at=now() where id=$1",[victim.id]);
      assert.equal((await db.query('select password_hash from crm_legacy_auth where auth_user_id=$1',[victim.id])).rows[0].password_hash,null);
      await assert.rejects(app.login('EMP5'),error=>error.status===401);
      assert.equal(app.authWrites.length,0);
      assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[victim.id])).rows[0].encrypted_password,'New-reset-password');
      const response=await app.login('EMP5','New-reset-password');
      assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/no-store/);
    });

    await t.test('first legitimate upgrade works once, hash is revoked atomically, and current password keeps working',async()=>{
      const imported=await account(db,6),app=handlers(db);
      assert.equal((await app.login('emp6')).status,200);
      assert.equal((await db.query('select password_hash from crm_legacy_auth where auth_user_id=$1',[imported.id])).rows[0].password_hash,null);
      assert.equal((await app.login(' EMP6 ')).status,200);assert.equal(app.authWrites.length,1);
      assert.deepEqual((await db.query('select raw_app_meta_data from auth.users where id=$1',[imported.id])).rows[0].raw_app_meta_data,{});
    });

    await t.test('native store usernames and emails authenticate through existing clients without password replacement',async()=>{
      const native=await account(db,90),app=handlers(db);
      await db.query('delete from crm_legacy_auth where auth_user_id=$1',[native.id]);
      await db.query("update auth.users set encrypted_password='Current-store-password' where id=$1",[native.id]);
      for(const identity of ['EMP90',native.email])assert.equal((await app.login(identity,'Current-store-password')).status,200);
      await assert.rejects(app.login('EMP90','Incorrect-password'),error=>error.status===401);
      assert.equal(app.authWrites.length,0);
      assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[native.id])).rows[0].encrypted_password,'Current-store-password');
    });

    await t.test('a reset between legacy verification and provider write cannot be overwritten',async()=>{
      const victim=await account(db,14),app=handlers(db,{resetBeforeUpgrade:true});
      await assert.rejects(app.login('EMP14'),error=>error.status===400);
      assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[victim.id])).rows[0].encrypted_password,'Concurrent-reset-password');
      assert.equal((await db.query('select password_hash from crm_legacy_auth where auth_user_id=$1',[victim.id])).rows[0].password_hash,null);
    });

    await t.test('current profile activity/email overrides stale import flags and stale auth email',async()=>{
      const inactive=await account(db,7,{active:false}),changed=await account(db,8);
      const app=handlers(db);
      await assert.rejects(app.login('EMP7'),error=>error.status===401);assert.equal(app.authWrites.length,0);
      await db.query('update profiles set email=$1 where id=$2',['changed@example.test',changed.id]);
      assert.equal((await app.login('EMP8')).status,200);assert.equal(app.providerCalls.at(-1),'changed@example.test');
      assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[inactive.id])).rows[0].encrypted_password,'Temporary-password');
    });

    await t.test('unknown, ambiguous, unusable and wildcard identities fail closed without password writes',async()=>{
      const app=handlers(db);await account(db,9);await account(db,10);
      await db.exec("update crm_legacy_auth set original_email='shared@example.test' where local_user_id in (9,10)");
      await db.exec("update crm_legacy_auth set password_hash='!unusable' where local_user_id=9");
      for(const identity of ['missing','EMP*','EMP_','shared@example.test','EMP9'])await assert.rejects(app.login(identity),error=>error.status===401);
      assert.equal(app.authWrites.length,0);
      // Literal unusual usernames do not turn into PostgREST wildcard filters.
      await db.exec("update crm_legacy_auth set username='EMP*' where local_user_id=10");
      assert.equal((await app.login('EMP*')).status,200);
    });

    await t.test('returned provider identity must match the selected legacy account',async()=>{
      const app=handlers(db,{wrongSessionUser:true});
      await assert.rejects(app.login('EMP6'),error=>error.status===401);
    });

    await t.test('password and hash revocation roll back together if the CRM trigger fails',async()=>{
      const victim=await account(db,11);
      await db.exec(`create function qa_fail_legacy_revoke() returns trigger language plpgsql as $$begin raise exception 'Injected legacy write failure';end$$;
        create trigger qa_fail_legacy_revoke before update on crm_legacy_auth for each row execute function qa_fail_legacy_revoke();`);
      try {await assert.rejects(db.query("update auth.users set encrypted_password='Changed' where id=$1",[victim.id]),/Injected legacy/);}
      finally {await db.exec('drop trigger qa_fail_legacy_revoke on crm_legacy_auth');}
      assert.equal((await db.query('select encrypted_password from auth.users where id=$1',[victim.id])).rows[0].encrypted_password,'Temporary-password');
      assert.equal((await db.query('select password_hash from crm_legacy_auth where auth_user_id=$1',[victim.id])).rows[0].password_hash,hash);
    });

    await t.test('one-time migration claim is exclusive, expiry-aware and consumes failed external attempts',async()=>{
      const token='synthetic-authorized-migration';const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
      const tokenHash=Buffer.from(digest).toString('hex');
      await db.query("insert into crm_migration_authorizations(token_hash,expires_at) values($1,now()+interval '1 hour')",[tokenHash]);
      const app=handlers(db,{failMigrationReads:true});
      await assert.rejects(app.migrate(token,{version:1,users:[{username:'Synthetic'}]}),/Injected provider/);
      assert.ok((await db.query('select used_at from crm_migration_authorizations where token_hash=$1',[tokenHash])).rows[0].used_at);
      await assert.rejects(app.migrate(token,{version:1,users:[{username:'Synthetic'}]}),error=>error.status===401);
      const live='a'.repeat(64),expired='b'.repeat(64);
      await db.query("insert into crm_migration_authorizations(token_hash,expires_at) values($1,now()+interval '1 hour'),($2,now()-interval '1 second')",[live,expired]);
      const claims=await Promise.all([db.query('select crm_claim_legacy_migration($1) claimed',[live]),db.query('select crm_claim_legacy_migration($1) claimed',[live])]);
      assert.deepEqual(claims.map(result=>result.rows[0].claimed).sort(),[false,true]);
      assert.equal((await db.query('select crm_claim_legacy_migration($1) claimed',[expired])).rows[0].claimed,false);
    });

    await t.test('service-only security-definer functions and business writes are denied to browser roles',async()=>{
      const anon=(await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE') order by p.proname`)).rows.map(row=>row.proname);
      assert.deepEqual(anon,['resolve_login_email']);
      const authenticated=(await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prosecdef and has_function_privilege('authenticated',p.oid,'EXECUTE') order by p.proname`)).rows.map(row=>row.proname);
      assert.deepEqual(authenticated,['can_view_store_member','create_timesheet_entry','current_user_role','delete_timesheet_entry',
        'get_dashboard_totals','get_store_dashboard_totals','is_admin','is_manager_or_admin','map_attendance_employee',
        'resolve_login_email','review_timesheet_entry','update_profile_image','update_timesheet_entry']);
      for(const name of ['crm_update_customer_internal(uuid,uuid,bigint,jsonb,boolean)',
        'crm_save_sales_visit_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)',
        'crm_save_task_photos_internal(bigint,uuid,text,jsonb,jsonb)',
        'crm_review_task_submission_internal(bigint,bigint,uuid,text,text)']) {
        assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[`public.${name}`])).rows[0].allowed,false);
      }
      const browserReads=(await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('authenticated',c.oid,'SELECT') order by c.relname`)).rows.map(row=>row.relname);
      assert.deepEqual(browserReads,['app_settings','attendance_devices','attendance_mappings','attendance_records','crm_task_notifications','profiles','timesheet_entries']);
      for(const role of ['anon','authenticated']) {
        const writes=(await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p') and
          (has_table_privilege($1,c.oid,'INSERT') or has_table_privilege($1,c.oid,'UPDATE') or has_table_privilege($1,c.oid,'DELETE'))`,[role])).rows;
        assert.deepEqual(writes,[]);
        for(const signature of ['crm_legacy_login_account(text)','crm_claim_legacy_migration(text)','crm_revoke_legacy_password()']) {
          assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,`public.${signature}`])).rows[0].allowed,false);
        }
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(db.query("select crm_legacy_login_account('EMP6')"),/permission denied/);
          await assert.rejects(db.query("select crm_claim_legacy_migration(repeat('a',64))"),/permission denied/);
          await assert.rejects(db.query('select password_hash from crm_legacy_auth'),/permission denied/);
        } finally {await db.exec('reset role');}
      }
      const buckets=(await db.query('select id,public from storage.buckets order by id')).rows;
      assert.ok(buckets.length>=2);assert.ok(buckets.every(bucket=>bucket.public===false));
    });

    await t.test('root cause reproduction: promotion/demotion can expose store A attendance to store B without the binding guard',async()=>{
      const storeB=uid(300);await db.query("insert into crm_stores(id,name) values($1,'Security synthetic store B')",[storeB]);
      const victim=await account(db,30,{store:fresh.store}),adminB=await account(db,31,{role:'admin',store:storeB});
      const record=(await db.query("insert into attendance_records(serial_number,punch_code,user_id,punched_at) values('qa','30',$1,now()) returning id",[victim.id])).rows[0];
      const visible=async()=>{
        await db.query("select set_config('request.jwt.claim.sub',$1,false)",[adminB.id]);
        await db.exec('set role authenticated');
        try {return (await db.query('select count(*) n from attendance_records where id=$1',[record.id])).rows[0].n;}
        finally {await db.exec('reset role');}
      };
      assert.equal(await visible(),0);
      await db.exec('alter table profiles disable trigger crm_preserve_profile_store');
      try {
        await db.query("update profiles set role='super_admin',store_id=null where id=$1",[victim.id]);
        await db.query("update profiles set role='employee',store_id=$1 where id=$2",[storeB,victim.id]);
        assert.equal(await visible(),1);
        await db.query("update profiles set role='employee',store_id=$1 where id=$2",[victim.store,victim.id]);
      } finally {await db.exec('alter table profiles enable trigger crm_preserve_profile_store');}
      assert.equal(await visible(),0);
    });

    await t.test('binding closes direct and promoted transfers, preserves same-store roles, and permits a new global first assignment',async()=>{
      const victim=await account(db,32,{store:fresh.store}),otherStore=uid(300);
      await assert.rejects(db.query('update profiles set store_id=$1 where id=$2',[otherStore,victim.id]),/original store/);
      await db.query("update profiles set role='super_admin',store_id=null where id=$1",[victim.id]);
      assert.equal((await db.query('select store_binding_id from profiles where id=$1',[victim.id])).rows[0].store_binding_id,victim.store);
      await assert.rejects(db.query("update profiles set role='employee',store_id=$1 where id=$2",[otherStore,victim.id]),/original store/);
      await assert.rejects(db.query('update profiles set store_binding_id=null where id=$1',[victim.id]),/original store binding/);
      await db.query("update profiles set role='manager',store_id=$1 where id=$2",[victim.store,victim.id]);
      await db.query("update profiles set role='employee' where id=$1",[victim.id]);
      const global=await account(db,33,{role:'super_admin'});
      await db.query("update profiles set role='employee',store_id=$1 where id=$2",[otherStore,global.id]);
      assert.equal((await db.query('select store_binding_id from profiles where id=$1',[global.id])).rows[0].store_binding_id,otherStore);
    });

    await t.test('real admin handler rejects cross-store demotion before changing provider email',async()=>{
      const victim=await account(db,34,{store:fresh.store}),app=handlers(db);
      await db.query("update profiles set role='super_admin',store_id=null where id=$1",[victim.id]);
      await assert.rejects(app.admin(victim.id,{role:'employee',store_id:uid(300),email:'changed-before-validation@example.test'}),error=>error.status===400);
      assert.equal(app.authWrites.length,0);
      assert.equal((await db.query('select email from profiles where id=$1',[victim.id])).rows[0].email,victim.email);
      assert.equal((await app.admin(victim.id,{role:'employee',store_id:fresh.store})).status,200);
    });

    await t.test('known global history is backfilled; ambiguous/unmapped legacy history fails closed on assignment',async()=>{
      assert.equal((await db.query('select store_binding_id from profiles where id=$1',[knownGlobal.id])).rows[0].store_binding_id,knownGlobal.store);
      await assert.rejects(db.query("update profiles set role='employee',store_id=$1 where id=$2",[uid(300),knownGlobal.id]),/original store/);
      await db.query("update profiles set role='employee',store_id=$1 where id=$2",[knownGlobal.store,knownGlobal.id]);
      await assert.rejects(db.query("update profiles set role='employee',store_id=$1 where id=$2",[knownGlobal.store,unresolvedGlobal.id]),/Historical store ownership is unresolved/);
      assert.equal((await db.query('select store_id from profiles where id=$1',[unresolvedGlobal.id])).rows[0].store_id,null);
    });

    await t.test('restrictive Storage policy denies direct CRM reads/writes even with an unrelated broad permissive policy',async()=>{
      await db.exec(`create policy qa_overbroad_storage on storage.objects for all to anon,authenticated using(true) with check(true);
        insert into storage.objects(id,bucket_id,name) values
        ('${uid(401)}','crm-task-images','owner/private.jpg'),('${uid(402)}','crm-visit-images','owner/private.jpg'),('${uid(403)}','unrelated-bucket','public.jpg');`);
      for(const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`);
        try {
          assert.deepEqual((await db.query('select bucket_id from storage.objects')).rows,[{bucket_id:'unrelated-bucket'}]);
          for(const bucket of ['crm-task-images','crm-visit-images']) {
            await assert.rejects(db.query('insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[uid(404),bucket,'forged.jpg']),/row-level security/);
          }
          assert.equal((await db.query("update storage.objects set name='changed' where bucket_id like 'crm-%' returning id")).rows.length,0);
          assert.equal((await db.query("delete from storage.objects where bucket_id like 'crm-%' returning id")).rows.length,0);
        } finally {await db.exec('reset role');}
      }
      await db.exec('set role service_role');
      try {
        assert.equal((await db.query("select count(*) n from storage.objects where bucket_id like 'crm-%'")).rows[0].n,2);
        await db.query("insert into storage.objects(id,bucket_id,name) values($1,'crm-task-images','authorized.jpg')",[uid(405)]);
        assert.equal((await db.query('delete from storage.objects where id=$1 returning id',[uid(405)])).rows.length,1);
      } finally {await db.exec('reset role');}
    });

    await t.test('same issued identity loses attendance/notification access and privileged RPCs immediately on deactivation',async()=>{
      const actor=await account(db,12),owner=await account(db,13,{role:'admin'});
      await db.query('insert into attendance_records(serial_number,punch_code,user_id,punched_at) values($1,$2,$3,now())',['synthetic-device','12',actor.id]);
      const task=(await db.query('insert into crm_assigned_tasks(assignee_id,assigned_by_id,title) values($1,$2,$3) returning id',[actor.id,owner.id,'Synthetic private title'])).rows[0];
      assert.ok(task.id);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor.id]);
      await db.exec('set role authenticated');
      try {
        assert.equal((await db.query('select count(*) n from attendance_records')).rows[0].n,1);
        assert.equal((await db.query('select count(*) n from crm_task_notifications')).rows[0].n,1);
      } finally {await db.exec('reset role');}
      await db.query('update profiles set active=false where id=$1',[actor.id]);
      await db.exec('set role authenticated');
      try {
        assert.equal((await db.query('select count(*) n from attendance_records')).rows[0].n,0);
        assert.equal((await db.query('select count(*) n from crm_task_notifications')).rows[0].n,0);
        await assert.rejects(db.query("select create_timesheet_entry(current_date,'Project','Details','General','09:00','17:00',0,false,'Completed','')"),/Active employee/);
        await assert.rejects(db.query("select update_profile_image('data:image/png;base64,synthetic')"),/Active employee/);
      } finally {await db.exec('reset role');}
    });
  } finally {await db.close();}
});
