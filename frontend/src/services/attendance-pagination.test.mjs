import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createReadCache} from './readCache.js';

const source=readFileSync(new URL('./attendanceSupabase.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
function fixture({employees=1,entries=2501,failOffset=-1}={}) {
  const reads=[];
  const profiles=Array.from({length:employees},(_,i)=>({id:`employee-${i}`,employee_id:`EMP${i}`,role:'employee',active:true,store_id:'A'}));
  const timesheets=Array.from({length:entries},(_,i)=>({id:`entry-${String(i).padStart(5,'0')}`,user_id:'employee-0',employee_id:'EMP0',work_date:'2026-11-07',created_at:'2026-11-07',total_hours:1,approval_status:'Submitted'}));
  const client={auth:{onAuthStateChange:()=>{}},from:table=>{
    const filters=[]; let bounds=[0,999];
    const query={select:()=>query,order:()=>query,eq:(k,v)=>{filters.push(r=>r[k]===v);return query;},in:(k,v)=>{filters.push(r=>v.includes(r[k]));return query;},gte:()=>query,lte:()=>query,
      range:(from,to)=>{bounds=[from,to];return query;},then:(resolve,reject)=>{
        reads.push({table,bounds});
        if(table==='timesheet_entries'&&bounds[0]===failOffset)return Promise.resolve({error:{message:'Later page failed'}}).then(resolve,reject);
        const rows=(table==='profiles'?profiles:timesheets).filter(row=>filters.every(f=>f(row)));
        return Promise.resolve({data:rows.slice(bounds[0],Math.min(bounds[0]+1000,bounds[1]+1))}).then(resolve,reject);
      }};return query;
  }};
  const api=new Function('createReadCache','crmSupabase','CRM_SUPABASE_URL','CRM_SUPABASE_PUBLISHABLE_KEY','readCrmProfile','createAttendanceFeed','activeStoreId',`${source};return {fetchAttendanceEmployees,fetchLiveTimesheet};`)(createReadCache,client,'http://local.test','local',async()=>profiles[0],()=>{},()=> 'A');
  return {...api,reads,profile:{id:'admin',role:'admin',storeId:'A'}};
}
test('reports and exports receive all 2,501 timesheets beyond the server response cap',async()=>{
  const app=fixture();const rows=await app.fetchLiveTimesheet({profile:app.profile});
  assert.equal(rows.length,2501);assert.equal(new Set(rows.map(r=>r.id)).size,2501);
  assert.equal(rows.reduce((sum,r)=>sum+r.totalHours,0),2501);
  assert.deepEqual(app.reads.filter(r=>r.table==='timesheet_entries').map(r=>r.bounds),[[0,499],[500,999],[1000,1499],[1500,1999],[2000,2499],[2500,2999]]);
});
test('more than 1,000 store employees are read before scoping attendance and reports',async()=>{
  const app=fixture({employees:1201}); const rows=await app.fetchAttendanceEmployees(app.profile);
  assert.equal(rows.length,1201);assert.equal(rows.at(-1).id,'employee-1200');
});
test('later-page failures reject an export rather than publishing a partial report',async()=>{
  const app=fixture({failOffset:1000});
  await assert.rejects(app.fetchLiveTimesheet({profile:app.profile}),/Later page failed/);
});
