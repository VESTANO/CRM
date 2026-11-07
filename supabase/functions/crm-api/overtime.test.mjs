import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source = readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const implementation = stripTypeScriptTypes(source.slice(source.indexOf('async function overtimeContext('), source.indexOf('async function handleOvertime(')));
function context(punches, error=null) {
  const query={select:()=>query,eq:()=>query,gte:()=>query,lt:()=>query,order:async()=>({data:punches.map(time=>({punched_at:`2026-11-04T${time}:00+05:30`})),error})};
  return new Function('adminClient','checkDb',`${implementation}; return overtimeContext;`)({from:()=>query},e=>{if(e)throw e;});
}
test('OT requires completed punch pairs after official end, rather than a lunch break or open work session',async()=>{
  for(const punches of [[],['09:30'],['09:30','13:00'],['09:30','13:00','14:00'],['09:30','17:35']]) {
    assert.equal((await context(punches)({},'2026-11-04')).actualPunchOut,null);
  }
  assert.match((await context(['09:30','18:10'])({},'2026-11-04')).actualPunchOut,/18:10/);
  assert.match((await context(['09:30','13:00','14:00','18:10'])({},'2026-11-04')).actualPunchOut,/18:10/);
});
test('uses migrated shift end and reports integration failures',async()=>{
  assert.match((await context(['09:00','17:10'])({shift_end_time:'17:00'},'2026-11-04')).actualPunchOut,/17:10/);
  await assert.rejects(context([],new Error('Database unavailable'))({},'2026-11-04'),/Database unavailable/);
  assert.equal((await context(['09:00','23:59'])({shift_end_time:'23:58'},'2026-11-04')).actualPunchOut,null);
});
test('pending OT verifies actual minutes against the captured shift, not the declared request or new shift',async()=>{
  const ctx={user:{id:'admin'},profile:{role:'admin'}};
  const item={id:1,employee_id:'employee',work_date:'2026-11-04',assigned_start_time:'09:30',assigned_end_time:'17:30',official_end_time:'17:35',requested_minutes:55,status:'pending'};
  const query={select:()=>query,eq:()=>query,gte:()=>query,lt:()=>query,order:async()=>({data:['09:30','18:10'].map(t=>({punched_at:`2026-11-04T${t}:00+05:30`}))})};
  const serialize=new Function('adminUserById','profileName','adminClient','checkDb',`${implementation};return serializeOvertime;`)(async()=>({id:'employee',employee_id:'EMP',shift_end_time:'19:00'}),async()=>null,{from:()=>query},error=>{if(error)throw error;});
  const result=await serialize(ctx,item);
  assert.equal(result.verifiedMinutes,35);assert.equal(result.requestedMinutes,55);assert.ok(result.actualPunchOut);
});
test('OT serialization receives the authenticated context and preserves stored review totals',async()=>{
  const ctx={user:{id:'admin-A'},profile:{role:'admin',store_id:'A'}};
  const item={id:1,employee_id:'employee-A',work_date:'2026-11-04',assigned_start_time:'09:30:00',assigned_end_time:'17:30:00',official_end_time:'17:35:00',declared_leave_time:'2026-11-04T12:30:00Z',actual_punch_out:'2026-11-04T12:40:00Z',requested_minutes:55,approved_minutes:65,status:'approved'};
  const serialize=new Function('adminUserById','profileName',`${implementation};return serializeOvertime;`)(async(c,id)=>{assert.equal(c,ctx);assert.equal(id,'employee-A');return {employee_id:'EMP-A',name:'Employee A'};},async()=>null);
  const result=await serialize(ctx,item);
  assert.equal(result.employeeName,'Employee A');assert.equal(result.approvedMinutes,65);
  assert.equal(result.actualPunchOut,item.actual_punch_out);
});
