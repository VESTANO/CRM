import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const actor='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const store='00000000-0000-4000-8000-000000000011',foreign='00000000-0000-4000-8000-000000000012';
const sql=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/crm-api/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
async function setup() {
  const db=new PGlite({extensions:{pgcrypto}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(sql('202611020001_crm_core'));
  const photos=sql('202611030013_photo_optimization');
  await db.exec(photos.slice(photos.indexOf('alter table public.crm_visit_images'),photos.indexOf('-- Keep the existing assignment')));
  await db.exec(`create table crm_stores(id uuid primary key,name text,features jsonb not null default '{"dashboard":true,"customers":true,"sales":true,"attendance":true,"callbacks":true,"reminders":true,"reports":true,"tasks":true}'::jsonb);alter table profiles add column store_id uuid references crm_stores;
    insert into auth.users values('${actor}'),('${other}');insert into crm_stores values('${store}','A'),('${foreign}','B');
    insert into profiles(id,employee_id,name,email,role,store_id) values('${actor}','A','Employee A','a@example.test','employee','${store}'),('${other}','B','Employee B','b@example.test','employee','${foreign}');`);
  await db.exec(sql('202611060006_persist_business_store'));
  await db.exec(sql('202611070006_customer_integrity'));
  await db.exec(`insert into crm_datasets(id,owner_id,store_id,name,original_filename) values(1,'${actor}','${store}','A','a.xlsx'),(2,'${other}','${foreign}','B','b.xlsx');
    insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data) values(1,1,'Leads',2,'{"name":"Alice","phone":"0012345678"}'),(2,2,'Leads',2,'{"name":"Bob"}');`);
  const allowed=new Set(['crm_customer_records','crm_datasets','crm_customer_record_changes','crm_visits','crm_visit_images','crm_stores']);
  const removed=[];
  const client={storage:{from:()=>({remove:async paths=>{removed.push(...paths);return {};}})},rpc:async(name,p)=>{
    try {const {rows}=await db.query('select crm_update_customer($1,$2,$3,$4::jsonb,$5) result',[p.p_actor,p.p_store,p.p_record,JSON.stringify(p.p_changes),p.p_complete]);return {data:rows[0].result,error:null};}
    catch(error){return {data:null,error};}
  },from:table=>{
    if(!allowed.has(table))throw new Error(`Unexpected table ${table}`);
    const filters=[];let operation='select',payload;
    const execute=async()=>{
      try {
        let statement;
        const values=[];const param=value=>{values.push(value&&typeof value==='object'&&!Array.isArray(value)?JSON.stringify(value):value);return '$'+values.length;};
        const where=()=>filters.length?' where '+filters.map(([key,value])=>Array.isArray(value)?`${key}=any(${param(value)}::bigint[])`:`${key}=${param(value)}`).join(' and '):'';
        if(operation==='update') statement=`update ${table} set ${Object.entries(payload).map(([key,value])=>`${key}=${param(value)}`).join(',')}${where()} returning *`;
        else if(operation==='insert')statement=`insert into ${table}(${Object.keys(payload).join(',')}) values(${Object.values(payload).map(param).join(',')}) returning *`;
        else if(operation==='delete')statement=`delete from ${table}${where()} returning *`;
        else statement=`select * from ${table}${where()}`;
        const {rows}=await db.query(statement,values);return {data:rows,error:null};
      } catch(error){return {data:null,error};}
    };
    const q={select:()=>q,eq:(key,value)=>{if(!/^[a-z_]+$/.test(key))throw Error('invalid test column');filters.push([key,value]);return q;},in:(key,values)=>{filters.push([key,values]);return q;},range:()=>q,order:()=>q,update:value=>{operation='update';payload=value;return q;},insert:value=>{operation='insert';payload=value;return q;},delete:()=>{operation='delete';return q;},single:async()=>{const r=await execute();return {...r,data:r.data?.[0]};},maybeSingle:async()=>{const r=await execute();return {...r,data:r.data?.[0]};},then:(yes,no)=>execute().then(yes,no)};
    return q;
  }};
  const api=new Function('createClient','Deno','corsHeaders',`${source};serializeDataset=async r=>r;recordDetail=async(ctx,record)=>({record});serializeRecord=async r=>r;callbackPayload=async r=>r;customerChangeHistory=async()=>[];datasetColumns=async()=>[];return routeApi;`)(()=>client,{env:{get:()=>''},serve:()=>{}},{});
  const context={user:{id:actor},profile:{role:'employee',store_id:store,active:true}};
  const route=(path,method,body,ctx=context)=>api(ctx,new Request('http://local.test/'+path,{method}),path,new URLSearchParams(),body,[]);
  return {db,route,context,removed};
}
test('real customer/callback handlers and PostgreSQL preserve history and scheduling integrity',async t=>{
  const {db,route,context,removed}=await setup();
  const current=async()=>(await db.query('select * from crm_customer_records where id=1')).rows[0];
  try {
    await t.test('dataset rename preserves workbook provenance and cross-store deletion is denied',async()=>{
      await route('datasets/1/manage','PATCH',{name:'Renamed QA'});
      assert.deepEqual((await db.query('select name,original_filename from crm_datasets where id=1')).rows,[{name:'Renamed QA',original_filename:'a.xlsx'}]);
      await assert.rejects(route('datasets/2/manage','DELETE',{}),e=>e.status===404);
    });
    await t.test('all five lead statuses persist, audit each transition and preserve original fields',async()=>{
      for(const response of ['interested','not_interested','callback','converted','no_response'])await route('datasets/1/customers/1','PATCH',{response,callback_date:response==='callback'?'2099-01-01':null,note:`Status ${response}`});
      assert.deepEqual((await current()).original_data,{name:'Alice',phone:'0012345678'});
      assert.equal(Number((await db.query('select count(*) n from crm_customer_record_changes')).rows[0].n),5);
    });
    await t.test('a failed audit write rolls back the customer mutation',async()=>{
      const before=await current();
      await db.exec("create function qa_history_fail() returns trigger language plpgsql as $$begin raise exception 'QA history failure';end$$;create trigger qa_history_fail before insert on crm_customer_record_changes for each row execute function qa_history_fail();");
      try {
        await assert.rejects(route('datasets/1/customers/1','PATCH',{response:'interested',note:'Must roll back'}));
        assert.equal((await current()).note,before.note);
      } finally {await db.exec('drop trigger qa_history_fail on crm_customer_record_changes');}
    });
    await t.test('completion is final once; rescheduling clears the previous completion receipt',async()=>{
      await route('datasets/1/customers/1','PATCH',{response:'callback',callback_date:'2099-01-01'});
      await route('callbacks/1/complete','POST',{response:'interested'});
      assert.equal((await current()).response,'interested');assert.ok((await current()).callback_completed_at);
      await assert.rejects(route('callbacks/1/complete','POST',{response:'converted'}));
      await route('datasets/1/customers/1','PATCH',{response:'callback',callback_date:'2099-01-02'});
      assert.equal((await current()).callback_completed_at,null);assert.equal((await current()).callback_completed_by,null);
      const duplicate=await Promise.allSettled([route('callbacks/1/complete','POST',{response:'interested'}),route('callbacks/1/complete','POST',{response:'converted'})]);
      assert.equal(duplicate.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(duplicate.filter(r=>r.status==='rejected').length,1);
    });
    await t.test('invalid/missing callback dates are rejected and other stores cannot mutate history',async()=>{
      for(const callback_date of [null,'2099-02-30','bad'])await assert.rejects(route('datasets/1/customers/1','PATCH',{response:'callback',callback_date}));
      await assert.rejects(route('datasets/2/customers/2','PATCH',{response:'converted'}),e=>e.status===404);
      await db.exec('set role authenticated');
      try {await assert.rejects(db.query('select crm_update_customer($1,$2,1,\'{}\'::jsonb,false)',[context.user.id,store]),/permission denied|does not exist/);}
      finally {await db.exec('reset role');}
    });
    await t.test('customer deletion cascades only its own history and keeps the other store intact',async()=>{
      await db.exec("insert into crm_visits(id,owner_id,store_id,customer_id,visit_date,meeting_time,location) values(10,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011',1,current_date,'10:00','QA');insert into crm_visit_images(visit_id,storage_path,original_name) values(10,'customer-photo','qa.jpg');");
      await route('datasets/1/customers/1','DELETE',{});
      assert.equal(Number((await db.query('select count(*) n from crm_customer_record_changes')).rows[0].n),0);
      assert.equal((await db.query('select original_data from crm_customer_records')).rows[0].original_data.name,'Bob');
      assert.equal(Number((await db.query('select count(*) n from crm_visits')).rows[0].n),0);
      assert.deepEqual(removed,['customer-photo']);
    });
    await t.test('failed dataset deletion preserves rows/images; successful deletion cleans its cascade only',async()=>{
      await db.exec("insert into crm_datasets(id,owner_id,store_id,name,original_filename) values(3,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','Delete QA','qa.xlsx');insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data) values(3,3,'Leads',2,'{\"name\":\"Local QA\"}');insert into crm_visits(id,owner_id,store_id,customer_id,visit_date,meeting_time,location) values(11,'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011',3,current_date,'10:00','QA');insert into crm_visit_images(visit_id,storage_path,thumbnail_path,original_name) values(11,'dataset-photo','dataset-thumb','qa.jpg');create function qa_delete_fail() returns trigger language plpgsql as $$begin raise exception 'QA delete failure';end$$;create trigger qa_delete_fail before delete on crm_datasets for each row execute function qa_delete_fail();");
      try {await assert.rejects(route('datasets/3/manage','DELETE',{}));assert.deepEqual(removed,['customer-photo']);assert.equal(Number((await db.query('select count(*) n from crm_visits where id=11')).rows[0].n),1);}
      finally {await db.exec('drop trigger qa_delete_fail on crm_datasets');}
      await route('datasets/3/manage','DELETE',{});
      assert.deepEqual(removed,['customer-photo','dataset-photo','dataset-thumb']);
      assert.equal(Number((await db.query('select count(*) n from crm_customer_records')).rows[0].n),1);
    });
  } finally {await db.close();}
});
