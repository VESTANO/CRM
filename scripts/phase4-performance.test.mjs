import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '../frontend/node_modules/@electric-sql/pglite/dist/index.js';
import { pgcrypto } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js';
import { pg_trgm } from '../frontend/node_modules/@electric-sql/pglite/dist/contrib/pg_trgm.js';

// The database is private, in-memory and synthetic. This never reads environment
// credentials or connects to a hosted instance. Plans are real PostgreSQL plans.
const actor='00000000-0000-4000-8000-000000000001', colleague='00000000-0000-4000-8000-000000000002', other='00000000-0000-4000-8000-000000000003';
const store='00000000-0000-4000-8000-000000000011', foreign='00000000-0000-4000-8000-000000000012';
const migration=name=>readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
const size=25000;
const bytes=value=>Buffer.byteLength(JSON.stringify(value));

// Transport adapter only: extracted current Edge handlers execute the real SQL
// functions above; no business rules are reimplemented by this adapter.
function handlers(db) {
  const reads=[];const calls=[];
  const tables=new Set(['crm_datasets','crm_customer_records','crm_dataset_columns','crm_manual_clients','profiles','crm_stores']);
  const client={rpc:async(name,p)=>{
    assert.ok(['crm_customer_history_page','crm_sales_visit_page','crm_sales_client_page'].includes(name));calls.push({name,p});
    try {const params=Object.values(p).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);const args=Object.keys(p).map((k,i)=>`${k}=>$${i+1}`).join(',');return {data:(await db.query(`select ${name}(${args}) result`,params)).rows[0].result,error:null};} catch(error){return {data:null,error};}
  },from:table=>{
    assert.ok(tables.has(table));reads.push(table);let columns='*',filters=[],orders=[],from=0,to=999;
    const execute=async()=>{
      try {const params=[];const clauses=filters.map(([key,value,many])=>{params.push(value);return `${key}${many?'=any($'+params.length+'::'+(key==='id'&&table==='profiles'?'uuid':'bigint')+'[])':'=$'+params.length}`;});
        const sql=`select ${columns} from ${table}${clauses.length?' where '+clauses.join(' and '):''}${orders.length?' order by '+orders.join(','):''} limit ${to-from+1} offset ${from}`;
        return {data:(await db.query(sql,params)).rows,error:null};} catch(error){return {data:null,error};}
    };
    const q={select:value=>{assert.match(value,/^[a-z_,*]+$/);columns=value;return q;},eq:(key,value)=>{assert.match(key,/^[a-z_]+$/);filters.push([key,value,false]);return q;},in:(key,value)=>{assert.match(key,/^[a-z_]+$/);filters.push([key,value,true]);return q;},order:(key,options={})=>{assert.match(key,/^[a-z_]+$/);orders.push(key+(options.ascending===false?' desc':' asc'));return q;},range:(start,end)=>{from=start;to=end;return q;},maybeSingle:async()=>{const r=await execute();return {...r,data:r.data?.[0]||null};},then:(yes,no)=>execute().then(yes,no)};return q;
  }};
  const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/crm-api/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
  const api=new Function('createClient','Deno','corsHeaders',`${source};return routeApi;`)(()=>client,{env:{get:()=>''},serve:()=>{}},{});
  const context={user:{id:actor},profile:{role:'employee',active:true,store_id:store}};
  const request=async(path,params={},ctx=context)=>{const response=await api(ctx,new Request('http://local.test/'+path),path,new URLSearchParams(params),{},[]);return response.json();};
  return {request,reads,calls,context};
}
async function setup() {
  const db=new PGlite({extensions:{pgcrypto,pg_trgm}});
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
    create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(migration('202611020001_crm_core'));
  await db.exec(`create table crm_stores(id uuid primary key,name text,features jsonb not null default '{"dashboard":true,"customers":true,"sales":true,"attendance":true,"callbacks":true,"reminders":true,"reports":true,"tasks":true}'::jsonb);alter table profiles add column store_id uuid references crm_stores;
    insert into auth.users values('${actor}'),('${colleague}'),('${other}');insert into crm_stores values('${store}','A'),('${foreign}','B');
    insert into profiles(id,employee_id,name,email,role,store_id) values
      ('${actor}','A','Employee A','a@example.test','employee','${store}'),
      ('${colleague}','C','Employee C','c@example.test','employee','${store}'),
      ('${other}','B','Employee B','b@example.test','employee','${foreign}');`);
  for(const name of ['202611060006_persist_business_store','202611070002_customer_query_performance','202611070003_dashboard_callbacks']) await db.exec(migration(name));
  const salesMigration=migration('202611070007_atomic_sales_visit');
  await db.exec(salesMigration.slice(salesMigration.indexOf('create function public.crm_sales_report'),salesMigration.indexOf("notify pgrst")));
  await db.exec(`insert into crm_datasets(id,owner_id,store_id,name,original_filename) values
    (1,'${actor}','${store}','West Synthetic','west.xlsx'),(2,'${other}','${foreign}','Private Synthetic','private.xlsx');
    insert into crm_dataset_columns(dataset_id,sheet_name,original_name,field_key,column_order) values(1,'Leads','Name','name',1),(1,'Leads','Phone','phone',2);
    insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data,response,callback_date,updated_at)
      select g,1,'Leads',g+1,jsonb_build_object('name','Synthetic '||g,'phone',lpad(g::text,10,'0'),'literal','100%_!'),'callback',date '2026-11-07'+g%3,timestamptz '2026-11-01 00:00:00Z'+g*interval '1 second' from generate_series(1,${size}) g;
    insert into crm_customer_records(id,dataset_id,sheet_name,row_number,original_data) values(${size+1},2,'Leads',2,'{"name":"Private"}');
    insert into crm_customer_record_changes(record_id,changed_by,previous_values,updated_values,changed_at)
      select 1,'${actor}',jsonb_build_object('note','before '||g),jsonb_build_object('note',repeat('x',500)||g),timestamptz '2026-11-01 00:00:00Z'+(g/3)*interval '1 second' from generate_series(1,${size}) g;
    insert into crm_visits(owner_id,store_id,customer_id,visit_date,meeting_time,location,expense,status,payment_status,total_amount,paid_amount,note,created_at)
      select case when g%2=0 then '${actor}'::uuid else '${colleague}'::uuid end,'${store}',g,date '2026-01-01'+g%300,time '10:00','Synthetic',0.10,
        case when g%5=0 then 'converted' else 'healthy' end,case when g%5=0 then 'completed' else 'not_paid' end,
        case when g%5=0 then 100.25 else 0 end,case when g%5=0 then 100.25 else 0 end,repeat('n',500),timestamptz '2026-01-01 00:00:00Z'+g*interval '1 second' from generate_series(1,${size}) g;
    insert into crm_visits(owner_id,store_id,customer_id,visit_date,meeting_time,location) values('${other}','${foreign}',${size+1},'2026-12-31','10:00','Private');
    insert into crm_manual_clients(id,owner_id,store_id,client_name) values(1,'${actor}','${store}','Manual 100%_!');
    insert into crm_visits(owner_id,store_id,manual_client_id,visit_date,meeting_time,location,status,payment_status,total_amount,paid_amount) values('${actor}','${store}',1,'2026-11-07','10:00','Synthetic','converted','completed',1.25,1.25);
    insert into crm_assigned_tasks(assignee_id,assigned_by_id,title,note,due_at,status,created_at)
      select '${actor}','${colleague}','Task '||g,repeat('t',500),timestamptz '2026-11-01 00:00:00Z'+g*interval '1 hour',case when g%2=0 then 'done' else 'pending' end,timestamptz '2026-01-01 00:00:00Z'+g*interval '1 second' from generate_series(1,${size}) g;
    analyze;`);
  return db;
}

test('25k histories, callbacks, sales and tasks: actual plans, bounded navigation and scoped SQL',async t=>{
  const db=await setup();const metrics={engine:'PGlite PostgreSQL (in-memory WASM, warm local synthetic data)',syntheticRows:size,plans:{},results:{},limitations:['Not hosted PostgREST or network latency','One database connection; not concurrent load','Offset and exact-count scans still grow for deep/search pages','Task and overtime endpoints still return complete histories']};
  const call=async(name,values)=>(await db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values.map(v=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):v))).rows[0].result;
  const plan=async(label,sql,params=[])=>{const p=(await db.query('explain (analyze,buffers,format json) '+sql,params)).rows[0]['QUERY PLAN'][0];metrics.plans[label]=p;return p;};
  const sales=(filters={},page=1,owner=null,scope=store)=>call('crm_sales_visit_page',[scope,owner,filters,page]);
  const history=(cursor=null)=>call('crm_customer_history_page',[1,cursor?.time||null,cursor?.id||null]);
  const clients=(q='',page=1,selected=null,dataset=1)=>call('crm_sales_client_page',[dataset,q,page,selected]);
  try {
    await t.test('record baseline plans and actual complete-response sizes before adding indexes',async()=>{
      const h=await db.query('select * from crm_customer_record_changes where record_id=1 order by changed_at desc,id desc');
      const v=await db.query('select * from crm_visits where store_id=$1 order by visit_date desc,meeting_time desc,created_at desc,id desc',[store]);
      const c=await db.query('select * from crm_customer_records where dataset_id=1 order by sheet_name,row_number,id');
      metrics.results.before={historyRows:h.rows.length,historyBytes:bytes(h.rows),salesRows:v.rows.length,salesBytes:bytes(v.rows),clientRows:c.rows.length,clientBytes:bytes(c.rows)};
      await plan('historyBefore','select * from crm_customer_record_changes where record_id=1 order by changed_at desc,id desc limit 50');
      await plan('salesBefore','select * from crm_visits where store_id=$1 order by visit_date desc,meeting_time desc,created_at desc,id desc limit 5',[store]);
      const reports=[];
      for(const scope of [store,foreign]) for(const owner of [null,actor,other]) reports.push({scope,owner,value:await call('crm_sales_report',[scope,owner,'2026-11-07'])});
      await plan('salesReportBefore',"select crm_sales_report($1,null,'2026-11-07')",[store]);
      await db.exec(migration('202611070011_phase4_performance'));await db.exec('analyze');
      for(const report of reports) assert.deepEqual(await call('crm_sales_report',[report.scope,report.owner,'2026-11-07']),report.value,'report shape and exact values preserved across optimization');
      await plan('salesReportAfter',"select crm_sales_report($1,null,'2026-11-07')",[store]);
      const firstHistory=await history(),firstSales=await sales(),firstClients=await clients();
      metrics.results.after={historyRows:firstHistory.records.length,historyBytes:bytes(firstHistory),salesRows:firstSales.records.length,salesBytes:bytes(firstSales),clientRows:firstClients.records.length,clientBytes:bytes(firstClients)};
      await plan('historyAfter','select * from crm_customer_record_changes where record_id=1 order by changed_at desc,id desc limit 50');
      await plan('salesAfter','select * from crm_visits where store_id=$1 order by visit_date desc,meeting_time desc,created_at desc,id desc limit 5',[store]);
      await plan('salesPageRpc','select crm_sales_visit_page($1,null,\'{}\',1)',[store]);
      await plan('clientPageRpc',"select crm_sales_client_page(1,'',1,null)");
      await plan('historyPageRpc','select crm_customer_history_page(1,null,null)');
      assert.equal(firstHistory.records.length,50);assert.equal(firstSales.records.length,5);assert.equal(firstClients.records.length,50);
      assert.ok(JSON.stringify(metrics.plans.historyAfter).includes('crm_customer_history_page_idx'));
      assert.ok(JSON.stringify(metrics.plans.salesAfter).includes('crm_visits_store_page_idx'));
      assert.ok(metrics.results.after.salesBytes < metrics.results.before.salesBytes/100);
    });
    await t.test('history cursor handles tied timestamps, deterministic pages and every one of 25000 entries',async()=>{
      const seen=new Set();let cursor=null;let pages=0;
      do {const page=await history(cursor);for(const row of page.records){assert.ok(!seen.has(row.id));seen.add(row.id);}cursor=page.nextCursor;pages+=1;} while(cursor);
      assert.equal(seen.size,size);assert.equal(pages,500);
      const first=await history();await plan('historySecondPage','select * from crm_customer_record_changes where record_id=1 and (changed_at,id)<($1::timestamptz,$2::bigint) order by changed_at desc,id desc limit 50',[first.nextCursor.time,first.nextCursor.id]);
      assert.equal((await call('crm_customer_history_page',[size+1,null,null])).records.length,0);
    });
    await t.test('sales filters and counts agree with an independent full-row reference, manual clients and both owner scopes',async()=>{
      const raw=(await db.query('select v.*,v.visit_date::text visit_date,v.meeting_time::text meeting_time,v.created_at::text created_at,coalesce(r.search_name,m.client_name) client_name,d.name dataset_name from crm_visits v left join crm_customer_records r on r.id=v.customer_id left join crm_datasets d on d.id=r.dataset_id left join crm_manual_clients m on m.id=v.manual_client_id')).rows;
      const filterCases=[{}, {q:'Synthetic 24'}, {q:'100%_!'}, {dataset_name:'west',payment_status:'completed'}, {status:'healthy',date_from:'2026-08-01',date_to:'2026-09-30'}, {q:'not present'}, {dataset_name:'private'}];
      for(const filters of filterCases) for(const owner of [null,actor]) {
        const expected=raw.filter(v=>{
          return v.store_id===store && (!owner||v.owner_id===owner)
            && (!filters.q||v.client_name.toLowerCase().includes(filters.q.toLowerCase()))
            && (!filters.dataset_name||(v.dataset_name||'').toLowerCase().includes(filters.dataset_name.toLowerCase()))
            && (!filters.status||v.status===filters.status)
            && (!filters.payment_status||(v.status==='converted'&&v.payment_status===filters.payment_status))
            && (!filters.date_from||v.visit_date>=filters.date_from) && (!filters.date_to||v.visit_date<=filters.date_to);
        }).sort((a,b)=>b.visit_date.localeCompare(a.visit_date)||b.meeting_time.localeCompare(a.meeting_time)||b.created_at.localeCompare(a.created_at)||b.id-a.id);
        const first=await sales(filters,1,owner),second=await sales(filters,2,owner);
        assert.equal(first.pagination.count,expected.length);assert.deepEqual(first.records.map(v=>v.id),expected.slice(0,5).map(v=>v.id));
        assert.deepEqual(second.records.map(v=>v.id),expected.slice(expected.length>5?5:0,expected.length>5?10:5).map(v=>v.id));
      }
      assert.equal((await sales({},1,null,foreign)).pagination.count,1);
      assert.equal((await sales({},1,other)).pagination.count,0);
      assert.equal((await sales({},1000000)).pagination.page,Math.ceil((size+1)/5));
      for(const filters of [{payment_status:'bad'},{status:'bad'},{q:'x'.repeat(501)},{date_from:'2026-99-99'}]) await assert.rejects(sales(filters));
      await assert.rejects(sales({},0));await assert.rejects(sales({},1000001));
      await plan('salesFilteredPageRpc','select crm_sales_visit_page($1,null,$2,1)',[store,JSON.stringify({q:'Synthetic 24',payment_status:'completed'})]);
      await plan('salesDeepPageRpc',"select crm_sales_visit_page($1,null,'{}',5000)",[store]);
    });
    await t.test('client lookup preserves arbitrary spreadsheet fields, literal wildcard text and out-of-page selection',async()=>{
      const first=await clients(),second=await clients('',2),last=await clients('',500),past=await clients('',501);
      assert.equal(first.pagination.hasMore,true);assert.equal(last.pagination.hasMore,false);assert.equal(past.records.length,0);
      assert.deepEqual(first.records.map(r=>r.id),Array.from({length:50},(_,i)=>i+1));assert.equal(second.records[0].id,51);
      assert.equal((await clients('0000024999')).records[0].id,24999);
      assert.equal((await clients('%_!')).records.length,50);
      assert.equal((await clients('',1,24999)).selected.id,24999);
      assert.equal((await clients('',1,size+1)).selected,null);
      assert.equal((await clients('private')).records.length,0);
      await assert.rejects(clients('x'.repeat(501)));await assert.rejects(clients('',0));
      await plan('clientFilteredRpc',"select crm_sales_client_page(1,'0000024999',1,null)");
    });
    await t.test('callbacks, sales aggregates and task plans use the complete synthetic dataset',async()=>{
      const callbacks=await call('crm_callback_page',[[1],'2026-11-07','2026-11-08',null,false,false,1]);
      const totals=await call('crm_visit_summary',[store,null,'2026-11-07']);
      assert.equal(callbacks.counts.total,size);assert.equal(callbacks.records.length,50);assert.equal(callbacks.pagination.count,size);
      assert.equal(callbacks.counts.today,Math.floor(size/3));assert.equal(totals.sales.totalVisits,size+1);assert.equal(totals.sales.totalVisitExpenses,2500);
      assert.equal(totals.payments.totalAmount,501251.25);assert.equal(totals.payments.pendingAmount,0);
      await plan('callbackPageRpc',"select crm_callback_page(array[1]::bigint[],'2026-11-07','2026-11-08',null,false,false,1)");
      await plan('salesSummaryRpc','select crm_visit_summary($1,null,\'2026-11-07\')',[store]);
      await plan('tasksExistingFullList','select * from crm_assigned_tasks where assignee_id=$1 order by status,due_at,created_at desc,id desc',[actor]);
      metrics.results.callbacks={rows:callbacks.records.length,total:callbacks.counts.total,bytes:bytes(callbacks)};
      metrics.results.tasks={rows:size,fullListRemains:true};
    });
    await t.test('browser roles cannot invoke trusted-scope service functions or read customer history directly',async()=>{
      for(const role of ['anon','authenticated']) {
        await db.exec('set role '+role);
        try {await assert.rejects(sales(),/permission denied/);await assert.rejects(history(),/permission denied/);await assert.rejects(clients(),/permission denied/);await assert.rejects(db.query('select * from crm_customer_record_changes'),/permission denied/);}
        finally {await db.exec('reset role');}
      }
      await db.exec('set role service_role');try {assert.equal((await sales()).records.length,5);}finally {await db.exec('reset role');}
    });
    await t.test('current Edge list/history/selector routes enforce store/owner scope, validate inputs and batch author names',async()=>{
      const {request,reads,calls,context}=handlers(db);
      const visits=await request('sales/visits',{page:'2',q:'Synthetic 24'});
      assert.equal(visits.results.length,5);assert.equal(visits.pagination.page,2);assert.ok(visits.results.every(v=>v.client_name.includes('Synthetic 24')));
      assert.equal(calls.at(-1).p.p_store,store);assert.equal(calls.at(-1).p.p_owner,actor);
      const admin={...context,profile:{...context.profile,role:'admin'}};
      const adminVisits=await request('sales/visits',{},admin);assert.equal(adminVisits.pagination.count,size+1);assert.equal(calls.at(-1).p.p_owner,null);
      const unknownStore={...admin,profile:{...admin.profile,store_id:foreign}};
      assert.equal((await request('sales/visits',{},unknownStore)).pagination.count,1);
      await assert.rejects(request('sales/clients',{dataset:'2'}),e=>e.status===404);
      await assert.rejects(request(`datasets/2/customers/${size+1}/history`),e=>e.status===404);
      const beforeProfiles=reads.filter(v=>v==='profiles').length;
      const first=await request('datasets/1/customers/1/history');assert.equal(first.entries.length,50);
      assert.ok(first.entries.every(e=>e.changed_by_username==='A'));
      assert.equal(reads.filter(v=>v==='profiles').length-beforeProfiles,1,'one author lookup per 50-entry page');
      const second=await request('datasets/1/customers/1/history',{before_time:first.nextCursor.time,before_id:String(first.nextCursor.id)});
      assert.ok(!second.entries.some(e=>first.entries.some(firstEntry=>firstEntry.id===e.id)));
      const options=await request('sales/clients',{dataset:'1',selected:'24999'});assert.equal(options.results.length,51);assert.ok(options.results.some(r=>r.id===24999));
      const page2=await request('sales/clients',{dataset:'1',page:'2'});assert.equal(page2.results[0].id,51);
      for(const params of [{page:'0'},{page:'1;select 1'},{date_from:'2026-02-31'},{payment_status:'bad'},{q:'x'.repeat(501)}]) await assert.rejects(request('sales/visits',params),e=>e.status===400);
      for(const params of [{before_time:'invalid',before_id:'1'},{before_time:'2026-11-01T00:00:00Z'},{before_time:'2026-11-01T00:00:00Z',before_id:'1 or true'}]) await assert.rejects(request('datasets/1/customers/1/history',params),e=>e.status===400);
      const global={...context,profile:{role:'super_admin',active:true,store_id:null}};
      await assert.rejects(request('sales/visits',{},global),e=>e.status===400);
    });
  } finally {
    const directory=new URL('../tmp/phase4/',import.meta.url);mkdirSync(directory,{recursive:true});writeFileSync(new URL('performance.json',directory),JSON.stringify(metrics,null,2));
    console.log('PHASE4_PERFORMANCE '+JSON.stringify({results:metrics.results,executionMs:Object.fromEntries(Object.entries(metrics.plans).map(([name,p])=>[name,p['Execution Time']]))}));await db.close();
  }
});
