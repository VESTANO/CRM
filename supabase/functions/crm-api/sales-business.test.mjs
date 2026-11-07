import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { PGlite } from '../../../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../../../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { buildSalesReportStats } from '../../../frontend/src/utils/sales.js';
import { defaultStoreFeatures } from '../../../frontend/src/services/storeFeatures.js';

const actor='00000000-0000-4000-8000-000000000001', employee='00000000-0000-4000-8000-000000000002', foreign='00000000-0000-4000-8000-000000000003';
const store='00000000-0000-4000-8000-000000000011', otherStore='00000000-0000-4000-8000-000000000012';
const ctx={user:{id:actor},profile:{id:actor,role:'admin',store_id:store}};
const migration=name=>readFileSync(new URL(`../../migrations/${name}.sql`,import.meta.url),'utf8');
const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));

// A SQL-backed Supabase query adapter for the real handlers. It preserves the
// PostgREST default 1,000-row cap so missing pagination is observable locally.
function clientFor(db){
  const quote=value=>`"${String(value).replaceAll('"','""')}"`;
  const calls=[]; const removed=[];
  return {calls,removed,storage:{from:()=>({remove:async paths=>{removed.push(...paths);return {};}})},
    rpc:async(name,args)=>{
      calls.push({name,args});
      try {return {data:(await db.query(`select ${quote(name)}(${Object.keys(args).map((_,i)=>`$${i+1}`).join(',')}) result`,Object.values(args))).rows[0].result,error:null};}
      catch(error){return {data:null,error};}
    },
    from:table=>{
      let columns='*',config={},mode='read',payload,range=null,conflict=[];const filters=[],orders=[];
      const execute=async()=>{
        const params=[]; const bind=v=>{params.push(v);return `$${params.length}`;};
        const where=()=>filters.length?' where '+filters.map(([op,k,v])=>op==='in'?`${quote(k)}=any(${bind(v)})`:`${quote(k)} ${op} ${bind(v)}`).join(' and '):'';
        try {
          let sql;
          if(mode==='insert'||mode==='upsert') {
            const keys=Object.keys(payload);sql=`insert into ${quote(table)}(${keys.map(quote).join(',')}) values(${keys.map(k=>bind(payload[k])).join(',')}) returning *`;
            if(mode==='upsert') sql=sql.replace(' returning *',` on conflict(${conflict.map(quote).join(',')}) do update set ${keys.filter(k=>!conflict.includes(k)).map(k=>`${quote(k)}=excluded.${quote(k)}`).join(',')} returning *`);
          } else if(mode==='update') sql=`update ${quote(table)} set ${Object.keys(payload).map(k=>`${quote(k)}=${bind(payload[k])}`).join(',')}${where()} returning *`;
          else if(mode==='delete') sql=`delete from ${quote(table)}${where()} returning *`;
          else if(config.count) sql=`select count(*) n from ${quote(table)}${where()}`;
          else sql=`select ${columns==='*'?'*':columns.split(',').map(quote).join(',')} from ${quote(table)}${where()}${orders.length?' order by '+orders.join(','):''} limit ${range?range[1]-range[0]+1:1000} offset ${range?.[0]||0}`;
          const rows=(await db.query(sql,params)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date ? (key==='month'||key.endsWith('_date')?value.toISOString().slice(0,10):value.toISOString()) : value])));
          return config.count?{data:config.head?null:rows,count:Number(rows[0].n),error:null}:{data:rows,error:null};
        } catch(error){return {data:null,error};}
      };
      const q={select:(c='*',o={})=>{columns=c;config=o;return q;},eq:(k,v)=>{filters.push(['=',k,v]);return q;},gte:(k,v)=>{filters.push(['>=',k,v]);return q;},lt:(k,v)=>{filters.push(['<',k,v]);return q;},in:(k,v)=>{filters.push(['in',k,v]);return q;},
        order:(k,o={})=>{orders.push(`${quote(k)} ${o.ascending===false?'desc':'asc'}`);return q;},range:(a,b)=>{range=[a,b];return q;},
        insert:v=>{mode='insert';payload=v;return q;},upsert:(v,o)=>{mode='upsert';payload=v;conflict=o.onConflict.split(',');return q;},update:v=>{mode='update';payload=v;return q;},delete:()=>{mode='delete';return q;},
        maybeSingle:async()=>{const result=await execute();return {...result,data:result.data?.[0]||null};},single:async()=>{const result=await execute();return {...result,data:result.data?.[0]||null};},
        then:(yes,no)=>execute().then(yes,no)};
      return q;
    }};
}
async function setup(){
  const db=new PGlite({extensions:{pgcrypto}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(migration('202611020001_crm_core'));
  await db.exec(migration('202611030001_visit_optional_meeting_fields'));
  const photos=migration('202611030013_photo_optimization');
  await db.exec(photos.slice(photos.indexOf('alter table public.crm_visit_images'),photos.indexOf('-- Keep')));
  await db.exec(`create table crm_stores(id uuid primary key,name text);alter table profiles add column store_id uuid references crm_stores;
    insert into auth.users values('${actor}'),('${employee}'),('${foreign}');insert into crm_stores values('${store}','A'),('${otherStore}','B');
    insert into profiles(id,employee_id,name,email,role,store_id) values('${actor}','ADMINA','Admin A','a@example.test','admin','${store}'),('${employee}','EMPA','Employee A','e@example.test','employee','${store}'),('${foreign}','EMPB','Employee B','b@example.test','employee','${otherStore}');`);
  await db.exec(migration('202611060006_persist_business_store'));
  await db.exec(`alter table crm_stores add column features jsonb not null default '${JSON.stringify(defaultStoreFeatures)}'::jsonb;`);
  await db.exec(migration('202611070003_dashboard_callbacks'));
  await db.exec(migration('202611070007_atomic_sales_visit'));
  await db.exec(`insert into crm_datasets(id,owner_id,store_id,name,original_filename) values(1,'${employee}','${store}','Leads','source.xlsx'),(2,'${foreign}','${otherStore}','Other','source.xlsx');
    insert into crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order) values(1,'Sheet1','Client','client',1);
    insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data) values(11,1,'Sheet1',2,'{"client":"Original client","phone":"0012345678"}'),(22,2,'Sheet1',2,'{"name":"Other store"}');`);
  const client=clientFor(db);
  let photoSequence=0;
  const api=new Function('createClient','Deno','corsHeaders','signedTaskImages','validateTaskImages','uploadPhotoObjects',`${source}; return {createOrUpdateVisit,serializeVisit,serializeVisitList,targetAndConversions,targetPayload,listTargets,routeApi};`)(
    ()=>client,{env:{get:()=>''},serve:()=>{}},{},async(_c,images)=>images,async()=>{},async()=>{const path=`${actor}/qa-${++photoSequence}.jpg`;return {images:[{storage_path:path,original_name:'qa.jpg',byte_size:100,width:10,height:10}],paths:[path]};});
  return {db,client,...api};
}
const base={visit_mode:'manual',client_name:'Synthetic client',visit_date:'2026-11-07',status:'converted',payment_status:'partially_paid',expense:'2.75',total_amount:'100.25',paid_amount:'30.10'};
const count=async(db,table)=>Number((await db.query(`select count(*) n from ${table}`)).rows[0].n);

test('sales and target business workflows execute real Edge handlers against isolated PostgreSQL',async t=>{
  const app=await setup();const {db}=app;
  try{
    await t.test('all invalid financial requests and calendar dates fail before creating or editing a manual client',async()=>{
      for(const fields of [{payment_status:'invalid'},{paid_amount:200},{status:'healthy',paid_amount:200},{visit_date:'2026-02-30'},{expense:'0.001'},{paid_amount:true},{visit_mode:'invented'},{total_amount:'10000000000'}]) {
        await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,...fields},[]),e=>e.status===400);
        assert.equal(await count(db,'crm_manual_clients'),0);assert.equal(await count(db,'crm_visits'),0);
      }
    });
    let manual,imported;
    await t.test('manual and imported visits preserve original customer data and agree with database financial totals',async()=>{
      manual=await app.createOrUpdateVisit(ctx,null,base,[]);
      imported=await app.createOrUpdateVisit(ctx,null,{...base,visit_mode:'existing',dataset:1,customer:11},[]);
      assert.equal(manual.pending_amount,70.15);assert.equal(imported.client_name,'Original client');
      assert.equal((await db.query('select original_data from crm_customer_records where id=11')).rows[0].original_data.phone,'0012345678');
      const totals=(await db.query("select crm_visit_summary($1,null,'2026-11-07') result",[store])).rows[0].result;
      assert.equal(totals.payments.totalAmount,200.5);assert.equal(totals.payments.paidAmount,60.2);assert.equal(totals.payments.pendingAmount,140.3);assert.equal(totals.sales.totalVisitExpenses,5.5);
      assert.equal((await app.targetAndConversions(employee,'2026-11-01')).converted_count,1,'conversions remain visible when no target exists');
    });
    await t.test('failed visit INSERT/UPDATE rolls back new or edited manual clients',async()=>{
      await db.exec("create function qa_sales_failure() returns trigger language plpgsql as $$begin raise exception 'Injected sales failure';end$$;create trigger qa_sales_failure before insert or update on crm_visits for each row execute function qa_sales_failure();");
      const clients=await count(db,'crm_manual_clients');
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,client_name:'Should roll back'},[]),/Injected sales failure/);
      assert.equal(await count(db,'crm_manual_clients'),clients);
      await assert.rejects(app.createOrUpdateVisit(ctx,manual.id,{...base,client_name:'Should not rename'},[]),/Injected sales failure/);
      assert.equal((await db.query('select client_name from crm_manual_clients where id=$1',[manual.manual_client.id])).rows[0].client_name,'Synthetic client');
      await db.exec('drop trigger qa_sales_failure on crm_visits');
    });
    await t.test('image metadata errors roll back financial/client records and clean only new objects',async()=>{
      const before=await count(db,'crm_visits'),clients=await count(db,'crm_manual_clients');
      await app.createOrUpdateVisit(ctx,null,{...base,client_name:'Image success'},[{}]);
      assert.equal(await count(db,'crm_visit_images'),1);
      await db.exec("create function qa_image_failure() returns trigger language plpgsql as $$begin raise exception 'Injected image metadata failure';end$$;create trigger qa_image_failure before insert on crm_visit_images for each row execute function qa_image_failure();");
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,client_name:'Image conflict'},[{}]),/Injected image metadata failure/);
      assert.equal(await count(db,'crm_visits'),before+1);assert.equal(await count(db,'crm_manual_clients'),clients+1);
      assert.deepEqual(app.client.removed,[`${actor}/qa-2.jpg`]);
      await db.exec('drop trigger qa_image_failure on crm_visit_images');
    });
    await t.test('each outcome/payment label can be saved; visit edits and deletes synchronize summaries',async()=>{
      for(const status of ['healthy','follow_up_required','interested','not_interested','converted']) {
        const edited=await app.createOrUpdateVisit(ctx,manual.id,{...base,status,payment_status:'completed',paid_amount:'100.25'},[]);
        assert.equal(edited.status,status);assert.equal(edited.pending_amount,0);
      }
      for(const payment_status of ['not_paid','partially_paid','completed','one_time']) assert.equal((await app.createOrUpdateVisit(ctx,manual.id,{...base,payment_status},[])).payment_status,payment_status);
      const result=await app.routeApi(ctx,new Request(`http://local.test/sales/visits/${imported.id}`,{method:'DELETE'}),`sales/visits/${imported.id}`,new URLSearchParams(),{},[]);
      assert.equal(result.status,204);assert.equal(Number((await db.query('select count(*) n from crm_visits where id=$1',[imported.id])).rows[0].n),0);
    });
    await t.test('same-store employee cannot edit another employee visit; foreign store customers and direct RPC access are denied',async()=>{
      const employeeCtx={user:{id:employee},profile:{id:employee,role:'employee',store_id:store}};
      await assert.rejects(app.createOrUpdateVisit(employeeCtx,manual.id,base,[]),e=>e.status===404);
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,visit_mode:'existing',dataset:2,customer:22},[]),e=>e.status===404);
      await db.exec('set role authenticated');try{
        await assert.rejects(db.query('select crm_save_sales_visit($1,$2,null,$3,null,$4)',[actor,store,JSON.stringify(base),'[]']),/permission denied/);
      }finally{await db.exec('reset role');}
    });
    await t.test('failed visit deletion retains attachment metadata and never deletes storage objects first',async()=>{
      const visit=(await db.query('select visit_id from crm_visit_images limit 1')).rows[0].visit_id;
      const removed=app.client.removed.length;
      await db.exec("create function qa_sales_delete_failure() returns trigger language plpgsql as $$begin raise exception 'Injected delete failure';end$$;create trigger qa_sales_delete_failure before delete on crm_visits for each row execute function qa_sales_delete_failure();");
      await assert.rejects(app.routeApi(ctx,new Request(`http://local.test/sales/visits/${visit}`,{method:'DELETE'}),`sales/visits/${visit}`,new URLSearchParams(),{},[]),/Injected delete failure/);
      assert.equal(await count(db,'crm_visit_images'),1);assert.equal(app.client.removed.length,removed);
      await db.exec('drop trigger qa_sales_delete_failure on crm_visits');
    });
    await t.test('lost create responses replay one visit; conflicting retries fail; new forms can record legitimate repeat visits',async()=>{
      const request_key='00000000-0000-4000-8000-000000000099';
      const before=await count(db,'crm_visits'),clients=await count(db,'crm_manual_clients');
      const first=await app.createOrUpdateVisit(ctx,null,{...base,request_key},[]);
      const second=await app.createOrUpdateVisit(ctx,null,{...base,request_key},[]);
      assert.equal(first.id,second.id);assert.equal(await count(db,'crm_visits'),before+1);assert.equal(await count(db,'crm_manual_clients'),clients+1);
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,request_key,note:'Different intent'},[]),e=>e.status===409);
      const separate=await app.createOrUpdateVisit(ctx,null,{...base,request_key:'00000000-0000-4000-8000-000000000098'},[]);
      assert.notEqual(separate.id,first.id);
      await db.query('delete from crm_visits where id=$1',[first.id]);
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,request_key},[]),/previously created visit was deleted/);
    });
    await t.test('replayed evidence removes only newly uploaded retry objects and rejects changed evidence bytes',async()=>{
      const request_key='00000000-0000-4000-8000-000000000097';
      const file=new File(['same bytes'],'evidence.png',{type:'image/png'});
      const before=await count(db,'crm_visit_images'),removed=app.client.removed.length;
      const first=await app.createOrUpdateVisit(ctx,null,{...base,request_key},[file]);
      const paths=(await db.query('select storage_path from crm_visit_images where visit_id=$1',[first.id])).rows.map(r=>r.storage_path);
      const replay=await app.createOrUpdateVisit(ctx,null,{...base,request_key},[file]);
      assert.equal(first.id,replay.id);assert.equal(await count(db,'crm_visit_images'),before+1);
      assert.equal(app.client.removed.length,removed+1);assert.equal(paths.includes(app.client.removed.at(-1)),false);
      await assert.rejects(app.createOrUpdateVisit(ctx,null,{...base,request_key},[new File(['different bytes'],'evidence.png',{type:'image/png'})]),e=>e.status===409);
      assert.equal(await count(db,'crm_visit_images'),before+1);
    });
    await t.test('targets calculate percentages, remaining counts and all rows beyond the default 1,000 cap',async()=>{
      await db.query("insert into crm_sales_targets(user_id,month,target) select $1,('1900-01-01'::date+(g||' months')::interval)::date,10 from generate_series(0,1004) g",[employee]);
      const targets=await app.listTargets(ctx,employee);assert.equal(targets.length,1005);
      const response=await app.routeApi(ctx,new Request('http://local.test/admin/targets',{method:'POST'}),'admin/targets',new URLSearchParams(),{userId:employee,month:'2026-11',target:2},[]);
      assert.equal(response.status,200);
      const target=(await db.query("select * from crm_sales_targets where user_id=$1 and month='2026-11-01'",[employee])).rows[0];
      target.month='2026-11-01';
      assert.equal((await app.targetPayload(target)).percentage,0,'deleted conversion no longer contributes');
      const next=await app.createOrUpdateVisit(ctx,null,{...base,visit_mode:'existing',dataset:1,customer:11},[]);
      assert.equal((await app.targetPayload(target)).percentage,50);assert.equal((await app.targetAndConversions(employee,'2026-11-01')).remaining_target,1);
      assert.equal((await app.listTargets(ctx,foreign)).length,0);
      const edited=await app.routeApi(ctx,new Request(`http://local.test/admin/targets/${target.id}`,{method:'PATCH'}),`admin/targets/${target.id}`,new URLSearchParams(),{target:4},[]);
      assert.equal((await edited.json()).percentage,25);
      for(const month of ['2026-13','2026-00','2026-02-30']) await assert.rejects(app.routeApi(ctx,new Request('http://local.test/admin/targets',{method:'POST'}),'admin/targets',new URLSearchParams(),{userId:employee,month,target:2},[]),e=>e.status===400);
    });
    await t.test('current and future monthly targets are not reported as already-failed historical periods',async()=>{
      const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).slice(0,7)+'-01';
      await db.query("insert into crm_sales_targets(user_id,month,target) values($1,$2,100),($1,'2099-01-01',100),($1,'2099-02-01',100) on conflict(user_id,month) do update set target=100",[employee,current]);
      const expected=Number((await db.query('select count(*) n from crm_sales_targets where user_id=$1 and month<$2',[employee,current])).rows[0].n);
      const targets=await app.listTargets(ctx,employee);
      assert.equal(targets[0].lowTargetCount,expected);
      const raw=(await db.query("select * from crm_sales_targets where user_id=$1 and month='2099-01-01'",[employee])).rows[0];raw.month='2099-01-01';
      assert.equal((await app.targetPayload(raw)).lowTargetCount,expected);
    });
    await t.test('25,000 visit serialization and sums stay complete and consistent',async()=>{
      await db.query("insert into crm_visits(owner_id,store_id,customer_id,visit_date,meeting_time,location,expense,status,payment_status,total_amount,paid_amount) select $1,$2,11,'2026-11-07',null,'',1.25,'converted','partially_paid',100.25,30.10 from generate_series(1,25000)",[employee,store]);
      const start=performance.now();
      const visits=(await db.query('select * from crm_visits where owner_id=$1',[employee])).rows;
      const serialized=await app.serializeVisitList(visits);
      assert.equal(serialized.length,visits.length);assert.equal(serialized.at(-1).pending_amount,70.15);
      const summary=(await db.query("select crm_visit_summary($1,$2,'2026-11-07') result",[store,employee])).rows[0].result;
      assert.equal(summary.sales.totalVisits,visits.length);assert.equal(summary.payments.pendingAmount,Number((visits.length*70.15).toFixed(2)));
      const serializationMs=performance.now()-start;
      const reportStart=performance.now();
      const employeeCtx={user:{id:employee},profile:{id:employee,role:'employee',store_id:store}};
      const report=await (await app.routeApi(employeeCtx,new Request('http://local.test/sales/report'),'sales/report',new URLSearchParams(),{},[])).json();
      const reportMs=performance.now()-reportStart;
      const expected=buildSalesReportStats(serialized.map(v=>({...v,visit_date:v.visit_date instanceof Date?v.visit_date.toISOString().slice(0,10):v.visit_date})));
      assert.equal(report.totalVisits,expected.totalVisits);assert.equal(report.totalExpenses,expected.totalExpenses);assert.deepEqual(report.recentMonths,expected.recentMonths);
      const foreignReport=(await db.query("select crm_sales_report($1,null,'2026-11-07') result",[otherStore])).rows[0].result;
      assert.equal(foreignReport.totalVisits,0);
      console.log(`PHASE3_SALES_25000 ${JSON.stringify({rows:visits.length,serializationMs:+serializationMs.toFixed(2),payloadBytes:Buffer.byteLength(JSON.stringify(serialized)),reportMs:+reportMs.toFixed(2),reportBytes:Buffer.byteLength(JSON.stringify(report))})}`);
    });
  }finally{await db.close();}
});
