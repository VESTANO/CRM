import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pg_trgm } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';

const actor='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
const store='00000000-0000-4000-8000-000000000011', foreign='00000000-0000-4000-8000-000000000012';
const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
async function setup() {
  const db=new PGlite({extensions:{pg_trgm,pgcrypto}});
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(migration('202611020001_crm_core'));
  await db.exec(`create table crm_stores(id uuid primary key,name text); alter table profiles add column store_id uuid references crm_stores;
    insert into auth.users values('${actor}'),('${other}');
    insert into crm_stores values('${store}','A'),('${foreign}','B');
    insert into profiles(id,employee_id,name,email,role,store_id) values
      ('${actor}','A','Admin A','a@example.test','admin','${store}'),('${other}','B','Admin B','b@example.test','admin','${foreign}');`);
  await db.exec(migration('202611060006_persist_business_store'));
  await db.exec(migration('202611070001_atomic_customer_import'));
  await db.exec(migration('202611070002_customer_query_performance'));
  await db.exec(migration('202611070003_dashboard_callbacks'));
  return db;
}
const meta=(fingerprint='a'.repeat(64),count=2)=>({fingerprint,datasetName:'QA import',filename:'qa.xlsx',sheets:[{name:'Leads',rows:count,column_names:['Name','Phone'],field_keys:['name','phone'],expected_rows:count}]});
const rows=[{sheet_name:'Leads',row_number:2,original_data:{name:'Alice',phone:'0012345678'}},{sheet_name:'Leads',row_number:3,original_data:{name:'Bob',phone:'0098765432'}}];
const call=async(db,action,job,payload={},user=actor,scope=store)=>(await db.query('select crm_import($1,$2,$3,$4,$5::jsonb) as value',[user,scope,action,job,JSON.stringify(payload)])).rows[0].value;
const count=async(db,table)=>Number((await db.query(`select count(*) n from ${table}`)).rows[0].n);

test('atomic import, failure recovery, identity/store boundaries and exact source preservation',async t=>{
  const db=await setup();
  try {
    let job;
    await t.test('staging and interrupted upload expose no dataset or customer; incomplete commit fails',async()=>{
      job=(await call(db,'start',null,meta())).id;
      await call(db,'batch',job,{rows:[rows[0]]});
      await assert.rejects(call(db,'commit',job),/Incomplete sheet/);
      assert.equal(await count(db,'crm_datasets'),0); assert.equal(await count(db,'crm_customer_records'),0);
    });
    await t.test('bad row rolls back the entire batch and reports sheet/row',async()=>{
      await assert.rejects(call(db,'batch',job,{rows:[rows[1],{...rows[1],row_number:4}]}),/Invalid customer row/);
      assert.equal(await count(db,'crm_import_rows'),1);
      await assert.rejects(call(db,'batch',job,{rows:[{...rows[1],original_data:{hidden:'unknown'}}]}),/Invalid customer fields/);
    });
    await t.test('unauthorized users/store overrides and direct browser RPC/table access fail',async()=>{
      await assert.rejects(call(db,'batch',job,{rows},other,foreign),/Import not found/);
      await assert.rejects(call(db,'start',null,meta(),actor,foreign),/not accessible/);
      await db.exec('set role authenticated');
      try {
        await assert.rejects(db.query('select * from crm_import_rows'),/permission denied/);
        await assert.rejects(call(db,'commit',job),/permission denied/);
        await assert.rejects(db.query("select crm_customer_page(array[1]::bigint[],'','',1,50,'customers')"),/permission denied/);
      } finally {await db.exec('reset role');}
    });
    await t.test('duplicate batch retry is idempotent; changing an uploaded row is rejected',async()=>{
      await call(db,'batch',job,{rows}); await call(db,'batch',job,{rows});
      assert.equal(await count(db,'crm_import_rows'),2);
      await assert.rejects(call(db,'batch',job,{rows:[{...rows[0],original_data:{...rows[0].original_data,name:'Changed'}}]}),/Retry changed row/);
    });
    await t.test('database failure during commit rolls back dataset, columns, customers and receipt',async()=>{
      await db.exec("create function qa_fail() returns trigger language plpgsql as $$begin raise exception 'QA injected database failure'; end$$; create trigger qa_fail before insert on crm_customer_records for each row execute function qa_fail();");
      await assert.rejects(call(db,'commit',job),/QA injected/);
      assert.equal(await count(db,'crm_datasets'),0); assert.equal(await count(db,'crm_dataset_columns'),0);
      assert.equal(await count(db,'crm_import_rows'),2);
      await db.exec('drop trigger qa_fail on crm_customer_records');
    });
    await t.test('lost commit response and same-file reinspection return one complete dataset',async()=>{
      const done=await call(db,'commit',job); const retry=await call(db,'commit',job);
      assert.equal(done.dataset.id,retry.dataset.id);
      assert.equal((await call(db,'start',null,meta())).dataset.id,done.dataset.id);
      assert.equal(await count(db,'crm_datasets'),1); assert.equal(await count(db,'crm_import_rows'),0);
      assert.deepEqual((await db.query('select original_data from crm_customer_records order by row_number')).rows.map(r=>r.original_data),rows.map(r=>r.original_data));
      assert.deepEqual((await db.query('select owner_id,store_id from crm_datasets')).rows,[{owner_id:actor,store_id:store}]);
    });
    await t.test('simultaneous starts deduplicate; distinct jobs stay separate',async()=>{
      const starts=await Promise.all([call(db,'start',null,meta('b'.repeat(64))),call(db,'start',null,meta('b'.repeat(64)))]);
      assert.equal(starts[0].id,starts[1].id);
      assert.notEqual((await call(db,'start',null,meta('c'.repeat(64)))).id,starts[0].id);
    });
    await t.test('invalid metadata creates no staging job; expired abandoned uploads can be cleaned',async()=>{
      const initial=await count(db,'crm_import_jobs');
      await assert.rejects(call(db,'start',null,{...meta('d'.repeat(64)),sheets:[{...meta().sheets[0],field_keys:['name','name']}]}),/Duplicate column keys/);
      assert.equal(await count(db,'crm_import_jobs'),initial);
      await db.exec("update crm_import_jobs set expires_at=now()-interval '1 day' where dataset_id is null; select crm_cleanup_imports();");
      assert.equal(await count(db,'crm_import_jobs'),1);
    });
    await t.test('search preserves literal wildcard behavior, original name fallback, edits and dataset scope',async()=>{
      const dataset=(await db.query('select id from crm_datasets limit 1')).rows[0].id;
      await db.exec('set role service_role');
      try { await db.query("update crm_customer_records set original_data=$1 where row_number=2",[JSON.stringify({name:'Alice 100%_!',phone:'0012345678'})]); }
      finally {await db.exec('reset role');}
      const page=async(q,mode='customers',ids=[dataset])=>(await db.query('select crm_customer_page($1,$2,\'\',1,20,$3) result',[ids,q,mode])).rows[0].result;
      assert.equal((await page('%_!')).count,1);
      assert.equal((await page('0012345678','dataset')).count,1);
      assert.equal((await page('Alice','customers',[])).count,0);
      assert.equal((await page('bob')).records[0].original_data.name,'Bob');
      await db.query("update crm_customer_records set original_data=$1 where row_number=2",[JSON.stringify({custom_a:'First value',custom_b:'Second value'})]);
      await db.query("update crm_dataset_columns set field_key='custom_b' where dataset_id=$1 and original_name='Name'",[dataset]);
      assert.equal((await page('Second value')).count,1,'column changes refresh the fallback search name in the same command');
    });
    await t.test('25,000 rows stage in bounded batches and publish one complete dataset',async()=>{
      const size=25000, start=performance.now();
      const large=(await call(db,'start',null,meta('e'.repeat(64),size))).id;
      for(let offset=0;offset<size;offset+=250) {
        const batch=Array.from({length:Math.min(250,size-offset)},(_,i)=>({sheet_name:'Leads',row_number:offset+i+2,original_data:{name:`Synthetic ${offset+i}`,phone:'0001234567'}}));
        await call(db,'batch',large,{rows:batch});
      }
      assert.equal(await count(db,'crm_datasets'),1);
      const committed=await call(db,'commit',large);
      assert.equal(Number((await db.query('select count(*) n from crm_customer_records where dataset_id=$1',[committed.dataset.id])).rows[0].n),size);
      assert.equal(await count(db,'crm_import_rows'),0);
      console.log(`LOCAL_25000_IMPORT_MS ${(performance.now()-start).toFixed(2)}`);
    });
    await t.test('callback pagination, sorting, completion counts and dashboard sums respect scope',async()=>{
      const dataset=(await db.query('select id from crm_datasets order by id desc limit 1')).rows[0].id;
      await db.query("update crm_customer_records set response='callback',callback_date='2026-11-07' where dataset_id=$1",[dataset]);
      const queue=async(ids,page=1)=>(await db.query("select crm_callback_page($1,'2026-11-07','2026-11-08',null,false,false,$2) result",[ids,page])).rows[0].result;
      assert.equal((await queue([])).counts.total,0);
      const first=await queue([dataset]),second=await queue([dataset],2);
      assert.equal(first.records.length,50); assert.equal(first.pagination.count,25000);
      assert.equal(first.records.some(r=>second.records.some(s=>s.id===r.id)),false);
      await db.query("insert into crm_manual_clients(owner_id,store_id,client_name) values($1,$2,'Synthetic client')",[actor,store]);
      await db.query("insert into crm_visits(owner_id,store_id,manual_client_id,visit_date,meeting_time,location,total_amount,paid_amount,expense) select $1,$2,id,'2026-11-07','10:00','QA',100.25,30.10,2.75 from crm_manual_clients",[actor,store]);
      const totals=(await db.query("select crm_visit_summary($1,null,'2026-11-07') result",[store])).rows[0].result;
      assert.equal(totals.payments.pendingAmount,70.15); assert.equal(totals.sales.totalVisits,1);
      assert.equal((await db.query("select crm_visit_summary($1,null,'2026-11-07') result",[foreign])).rows[0].result.sales.totalVisits,0);
    });
  } finally {await db.close();}
});

test('1k/5k/10k/25k isolated PostgreSQL search and response-size measurements',async()=>{
  const db=await setup(); const measurements=[];
  try {
    for (const size of [1000,5000,10000,25000]) {
      const id=(await db.query("insert into crm_datasets(owner_id,store_id,name,original_filename) values($1,$2,$3,'synthetic.xlsx') returning id",[actor,store,`Synthetic ${size}`])).rows[0].id;
      await db.query("insert into crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order) values($1,'Leads','Name','name',1)",[id]);
      await db.query(`insert into crm_customer_records(dataset_id,sheet_name,row_number,original_data,response) select $1,'Leads',g+1,jsonb_build_object('name','Customer '||g,'phone','0001234567','notes',repeat('synthetic ',60)),case when g%2=0 then 'interested' else 'no_response' end from generate_series(1,$2::integer) g`,[id,size]);
      await db.exec('analyze crm_customer_records');
      const before=[],after=[]; let beforeBytes,afterBytes;
      for(let run=0;run<3;run++) {
        let start=performance.now();
        const all=(await db.query('select * from crm_customer_records where dataset_id=$1 order by sheet_name,row_number',[id])).rows;
        const filtered=all.filter(r=>r.original_data.name.toLowerCase().includes('customer 9'));
        const expected=filtered.slice(0,50).map(r=>r.id);
        beforeBytes=Buffer.byteLength(JSON.stringify(all)); before.push(performance.now()-start);
        start=performance.now();
        const page=(await db.query("select crm_customer_page(array[$1]::bigint[],'customer 9','',1,50,'customers') result",[id])).rows[0].result;
        afterBytes=Buffer.byteLength(JSON.stringify(page)); after.push(performance.now()-start);
        assert.deepEqual(page.records.map(r=>r.id),expected); assert.equal(page.count,filtered.length);
        const second=(await db.query("select crm_customer_page(array[$1]::bigint[],'customer 9','interested',2,50,'customers') result",[id])).rows[0].result;
        assert.equal(second.count,filtered.filter(r=>r.response==='interested').length);
      }
      const median=a=>a.sort((x,y)=>x-y)[1];
      const counts=(await db.query('select * from crm_dataset_counts(array[$1]::bigint[])',[id])).rows;
      assert.equal(Number(counts[0].customer_count),size);
      measurements.push({customers:size,beforeMs:+median(before).toFixed(2),afterMs:+median(after).toFixed(2),beforeBytes,afterBytes});
    }
    console.log('LOCAL_PG_MEASUREMENTS '+JSON.stringify(measurements));
    mkdirSync(new URL('../tmp/phase2/',import.meta.url),{recursive:true});
    writeFileSync(new URL('../tmp/phase2/performance.json',import.meta.url),JSON.stringify({environment:'PGlite PostgreSQL WASM, 3 runs, median; not hosted latency',measurements},null,2));
  } finally {await db.close();}
});
