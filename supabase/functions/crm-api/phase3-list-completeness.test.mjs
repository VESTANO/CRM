import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Execute the real GET routes against a server-cap adapter (1000 rows unless
// ranged). Serializers are identity adapters so this measures list completeness
// and authorization, not image signing, Auth, or the hosted PostgREST service.
const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
const store='00000000-0000-4000-8000-000000000011',foreign='00000000-0000-4000-8000-000000000012';
function fixture(failAt=null) {
  const own=Array.from({length:2501},(_,i)=>({id:i+1,assignee_id:'employee-a',employee_id:'employee-a',status:'approved',approved_minutes:2,due_at:null,created_at:'2026-11-07T00:00:00Z',work_date:'2026-11-07'}));
  const sameStore=Array.from({length:37},(_,i)=>({...own[0],id:3000+i,assignee_id:'colleague-a',employee_id:'colleague-a'}));
  const other=Array.from({length:13},(_,i)=>({...own[0],id:4000+i,assignee_id:'employee-b',employee_id:'employee-b'}));
  const tables={crm_stores:[{id:store,features:{}},{id:foreign,features:{}}],profiles:[{id:'employee-a',store_id:store},{id:'colleague-a',store_id:store},{id:'employee-b',store_id:foreign}],crm_assigned_tasks:[...own,...sameStore,...other],crm_overtime_requests:[...own,...sameStore,...other]};
  const pages=[];
  const client={from:table=>{
    const filters=[],orders=[];let range=null;
    const q={maybeSingle:async()=>{const result=await new Promise((yes,no)=>q.then(yes,no));return {...result,data:result.data?.[0]||null};},select:()=>q,eq:(key,value)=>{filters.push(row=>row[key]===value);return q;},in:(key,values)=>{filters.push(row=>values.includes(row[key]));return q;},order:(key,{ascending=true}={})=>{orders.push({key,ascending});return q;},range:(start,end)=>{range=[start,end];return q;},then:(yes,no)=>{
      const start=range?.[0]||0;pages.push({table,start,orders:orders.map(item=>item.key)});
      if(table!=='profiles'&&start===failAt)return Promise.resolve({data:null,error:{message:'QA late-page failure'}}).then(yes,no);
      const rows=(tables[table]||[]).filter(row=>filters.every(filter=>filter(row))).sort((a,b)=>{
        for(const {key,ascending} of orders){const comparison=a[key]==null&&b[key]==null?0:a[key]<b[key]?-1:a[key]>b[key]?1:0;if(comparison)return ascending?comparison:-comparison;}return 0;
      });
      return Promise.resolve({data:rows.slice(start,range?Math.min(range[1]+1,start+1000):1000),error:null}).then(yes,no);
    }};return q;
  }};
  const api=new Function('createClient','Deno','corsHeaders',`${source};serializeTasks=async tasks=>tasks;serializeOvertime=async(ctx,item)=>item;return routeApi;`)(()=>client,{env:{get:()=>''},serve:()=>{}},{});
  const call=(path,role='employee',params={})=>api({user:{id:'employee-a'},profile:{role,store_id:store}},new Request('http://local.test/'+path),path,new URLSearchParams(params),{},[]);
  return {call,pages};
}
test('own task list includes all 2501 rows and no other assignees',async()=>{
  const app=fixture();const result=await(await app.call('tasks')).json();
  assert.equal(result.results.length,2501);assert.ok(result.results.every(row=>row.assignee_id==='employee-a'));
  assert.deepEqual(app.pages.filter(page=>page.table==='crm_assigned_tasks').map(page=>page.start),[0,1000,2000]);
  assert.ok(app.pages.filter(page=>page.table==='crm_assigned_tasks').every(page=>page.orders.at(-1)==='id'));
});
test('admin task list preserves current-store scope and explicit assignee filtering across pages',async()=>{
  const app=fixture();const result=await(await app.call('admin/tasks','admin')).json();
  assert.equal(result.results.length,2538);assert.equal(result.results.some(row=>row.assignee_id==='employee-b'),false);
  const selected=await(await app.call('admin/tasks','admin',{userId:'employee-a'})).json();assert.equal(selected.results.length,2501);
  const denied=await(await app.call('admin/tasks','admin',{userId:'employee-b'})).json();assert.equal(denied.results.length,0);
});
test('overtime list includes every own/current-store row and computes totals from all pages',async()=>{
  const app=fixture();const own=await(await app.call('overtime')).json();
  assert.equal(own.requests.length,2501);assert.equal(own.approvedMinutes,5002);
  const admin=await(await app.call('overtime','admin')).json();assert.equal(admin.requests.length,2538);assert.equal(admin.approvedMinutes,5002);
  assert.equal(admin.requests.some(row=>row.employee_id==='employee-b'),false);
  assert.ok(app.pages.filter(page=>page.table==='crm_overtime_requests').every(page=>page.orders.at(-1)==='id'));
});
test('late task/overtime page failures reject the full response rather than returning partial data',async()=>{
  for(const [path,role] of [['tasks','employee'],['admin/tasks','admin'],['overtime','employee'],['overtime','admin']]) {
    const app=fixture(1000);await assert.rejects(app.call(path,role),e=>e.status===503 && /check.*before retrying/i.test(e.message) && !e.message.includes('QA late-page failure'));
  }
});
