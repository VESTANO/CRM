import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source = readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const implementation = stripTypeScriptTypes(source.slice(source.indexOf('async function overtimeContext('), source.indexOf('async function handleOvertime(')));
function context(punches, error=null) {
  const query={select:()=>query,eq:()=>query,gte:()=>query,lte:()=>query,order:async()=>({data:punches.map(time=>({punched_at:`2026-11-04T${time}:00+05:30`})),error})};
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
});
