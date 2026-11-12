import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Execute the real handler logic with a deterministic I/O adapter. This file
// proves API decisions/calculations, not Supabase Auth or network delivery.
const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
const a='00000000-0000-4000-8000-000000000011',b='00000000-0000-4000-8000-000000000012';
function fixture({profileWriteError=false,syncFailure=false}={}) {
  const writes=[],authWrites=[],deleted=[];
  // Employees require a designation. Keeping this fixture valid lets these
  // tests reach the Auth rollback paths they are intended to exercise.
  const target={id:'employee',employee_id:'EMP',email:'old@example.test',role:'employee',active:true,designation:'Sales',store_id:a};
  const tables={profiles:[target],crm_stores:[{id:a},{id:b}],crm_datasets:[{id:1,owner_id:'employee',store_id:a},{id:2,owner_id:'employee',store_id:a}],crm_reminders:[{id:1,owner_id:'employee',store_id:a,text:'A',reminder_at:'2099-01-01T00:00:00Z'},{id:2,owner_id:'other',store_id:b,text:'B',reminder_at:'2099-01-01T00:00:00Z'}]};
  const client={auth:{getUser:async()=>({data:{user:{id:'employee'}}}),admin:{createUser:async()=>({data:{user:{id:'new-account'}}}),deleteUser:async id=>{deleted.push(id);return {};},updateUserById:async(id,body)=>{authWrites.push({id,body});return {data:{}};}}},from:table=>{
    const filters=[];let payload,operation='select',duplicate=false;
    const execute=()=>{
      let data=duplicate?[]:(tables[table]||[]).filter(row=>filters.every(fn=>fn(row)));
      if(profileWriteError && table==='profiles' && operation!=='select')return {data:null,error:{code:'P0001',message:'QA profile write failure'}};
      if(operation==='insert'){const row={id:100,...payload};(tables[table]||=[]).push(row);data=[row];writes.push({table,payload});}
      if(operation==='update'){data.forEach(row=>Object.assign(row,payload));writes.push({table,payload});}
      if(operation==='delete'){tables[table]=(tables[table]||[]).filter(row=>!data.includes(row));writes.push({table,payload});}
      return {data:structuredClone(data),count:data.length,error:null};
    };
    const q={select:()=>q,eq:(key,value)=>{filters.push(row=>row[key]===value);return q;},neq:(key,value)=>{filters.push(row=>row[key]!==value);return q;},or:()=>{duplicate=true;return q;},order:()=>q,range:()=>q,limit:()=>q,insert:value=>{payload=value;operation='insert';return q;},update:value=>{payload=value;operation='update';return q;},delete:()=>{operation='delete';return q;},maybeSingle:async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},single:async()=>{const r=execute();return {...r,data:r.data?.[0]||null};},then:(yes,no)=>Promise.resolve(execute()).then(yes,no)};
    return q;
  }};
  const api=new Function('createClient','Deno','corsHeaders','syncFailure',`${source};
    allAuthUsers=async()=>[]; datasetRecordCounts=async()=>[{dataset_id:1,customer_count:17},{dataset_id:2,customer_count:3}];
    profileWithCounts=async p=>p;
    syncAttendanceAdmin=async()=>{if(syncFailure)throw new Error('QA sync failure');};
    return {routeApi,handleAdmin,authenticate};`)(()=>client,{env:{get:()=>''},serve:()=>{}},{},syncFailure);
  const context={user:{id:'employee'},profile:target};
  return {writes,authWrites,deleted,tables,context,
    route:(path,method='GET',body={},ctx=context)=>api.routeApi(ctx,new Request('http://local.test/'+path,{method}),path,new URLSearchParams(),body,[]),
    admin:(path,method='GET',body={},ctx={user:{id:'global'},profile:{role:'super_admin'},activeStoreId:a})=>api.handleAdmin(ctx,method,path.split('/'),new URLSearchParams(),body),
    authenticate:()=>api.authenticate(new Request('http://local.test',{headers:{Authorization:'Bearer test'}}))};
}
test('admin summary sums grouped customer counts rather than counting datasets',async()=>{
  const app=fixture();const result=await (await app.admin('admin/summary')).json();
  assert.equal(result.metrics.totalCustomers,20);
});
test('invalid store reassignment is rejected before changing authentication email',async()=>{
  const app=fixture();
  await assert.rejects(app.admin('admin/users/employee','PATCH',{email:'new@example.test',store_id:b}),e=>e.status===400);
  assert.equal(app.authWrites.length,0);assert.equal(app.tables.profiles[0].email,'old@example.test');
});
test('profile creation failure removes only the new authentication account',async()=>{
  const app=fixture({profileWriteError:true});
  await assert.rejects(app.admin('admin/users','POST',{username:'NEW',email:'new@example.test',password1:'password123',password2:'password123',designation:'Sales',store_id:a}));
  assert.deepEqual(app.deleted,['new-account']);
});
test('profile edit failure restores an already changed authentication email',async()=>{
  const app=fixture({profileWriteError:true});
  await assert.rejects(app.admin('admin/users/employee','PATCH',{email:'new@example.test'}));
  assert.deepEqual(app.authWrites.map(write=>write.body.email),['new@example.test','old@example.test']);
});
test('promotion detaches only the profile store; demotion needs a valid explicit store',async()=>{
  const app=fixture();
  await app.admin('admin/users/employee','PATCH',{role:'super_admin'});
  assert.equal(app.tables.profiles[0].store_id,null);assert.equal(app.tables.crm_datasets[0].store_id,a);
  const global={user:{id:'global'},profile:{role:'super_admin'}};
  await assert.rejects(app.admin('admin/users/employee','PATCH',{role:'admin'},global),e=>e.status===400);
  await assert.rejects(app.admin('admin/users/employee','PATCH',{role:'admin',store_id:'missing'},global),e=>e.status===400);
  await app.admin('admin/users/employee','PATCH',{role:'admin',store_id:b},global);
  assert.equal(app.tables.profiles[0].store_id,b);assert.equal(app.tables.crm_datasets[0].store_id,a);
});
test('failed role synchronization restores the original role and store',async()=>{
  const app=fixture({syncFailure:true});
  await assert.rejects(app.admin('admin/users/employee','PATCH',{role:'super_admin'}),e=>e.status===503);
  assert.equal(app.tables.profiles[0].role,'employee');assert.equal(app.tables.profiles[0].store_id,a);
});
test('inactive profiles cannot authenticate even with a valid provider user',async()=>{
  const app=fixture();app.tables.profiles[0].active=false;
  await assert.rejects(app.authenticate(),e=>e.status===403);
});
test('reminders are private to the owner and store, including direct update/delete attempts',async()=>{
  const app=fixture();
  for(const method of ['PATCH','DELETE'])await assert.rejects(app.route('reminders/2',method,{text:'changed'}),e=>e.status===404);
  const foreignContext={...app.context,profile:{...app.context.profile,store_id:b}};
  await assert.rejects(app.route('reminders/1','PATCH',{text:'changed'},foreignContext),e=>e.status===404);
  assert.equal(app.writes.length,0);
});
test('reminder creation preserves timezone instant and rejects invalid/past schedules',async()=>{
  const app=fixture();
  await app.route('reminders','POST',{text:'Timezone test',reminder_at:'2099-01-02T09:00:00+05:30'});
  assert.equal(app.writes[0].payload.reminder_at,'2099-01-02T03:30:00.000Z');
  for(const reminder_at of ['not-a-date','2000-01-01T00:00:00Z'])await assert.rejects(app.route('reminders','POST',{text:'Invalid',reminder_at}),e=>e.status===400);
  assert.equal(app.writes.length,1);
});
