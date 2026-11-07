import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
const app=new Function('createClient','Deno','corsHeaders',`${source};return {checkDb,updateCustomerWithHistory};`)(()=>({rpc:async(name,args)=>({data:args.p_changes,error:globalThis.qaConflictError})}),{env:{get:()=>''},serve:()=>{}},{});
test('database timeouts and provider failures offer safe retry without leaking SQL diagnostics',()=>{
  for(const code of ['57014','55P03','40001','40P01','08006','XX000','PGRST002',undefined]) {
    assert.throws(()=>app.checkDb({code,message:'secret connection string and internal relation'}),error=>error.status===503 && /check.*before retrying/i.test(error.message) && !error.message.includes('secret'));
  }
  assert.throws(()=>app.checkDb({code:'23505',message:'private_constraint'}),e=>e.status===409 && !e.message.includes('private_constraint'));
  assert.throws(()=>app.checkDb({code:'42501',message:'private_table'}),e=>e.status===403 && !e.message.includes('private_table'));
  assert.throws(()=>app.checkDb({code:'22P02',message:'private supplied value'}),e=>e.status===400 && !e.message.includes('private'));
  assert.throws(()=>app.checkDb({code:'P0001',message:'Choose a callback date'}),/Choose a callback date/);
});
test('customer handler forwards the version the user edited and maps conflicts without retrying writes',async()=>{
  const ctx={user:{id:'actor'},profile:{role:'employee',store_id:'store'}};
  globalThis.qaConflictError=null;
  const sent=await app.updateCustomerWithHistory(ctx,1,{response:'interested',expected_revision:4,original_data:{name:'forbidden'}});
  assert.deepEqual(sent,{response:'interested',expected_revision:4});
  for(const [code,status] of [['PT409',409],['PT428',428]]) {
    globalThis.qaConflictError={code};
    await assert.rejects(app.updateCustomerWithHistory(ctx,1,{note:'draft',expected_revision:4}),e=>e.status===status && /reload/i.test(e.message));
  }
  delete globalThis.qaConflictError;
});
