import assert from "node:assert/strict";
import test from "node:test";
import { nativeReminderDeviceRequest } from "./native-reminder-device.ts";
function setup(owner=null,expired=false){
  const filters=[],writes=[];
  const db={from:()=>{
    let updating=false;
    const query={select:()=>query,is:(k,v)=>{filters.push([k,v]);return query;},gt:()=>query,
      eq:(k,v)=>{filters.push([k,v]);return query;},order:async()=>({data:[]}),
      update:v=>{updating=true;writes.push(v);return query;},
      maybeSingle:async()=>({data:updating?{id:"device"}:{id:"device",owner_id:owner,pair_expires_at:new Date(Date.now()+(expired?-1:600000)).toISOString()}}),
      then:resolve=>resolve({}),
    };return query;
  }};
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  return {filters,writes,run:(method,parts,body={})=>nativeReminderDeviceRequest(db,"signed-in-owner",method,parts,body,fail)};
}
test("pairing binds only to the authenticated CRM owner, ignoring supplied user IDs",async()=>{
  const app=setup();
  await app.run("POST",["native-reminder-devices","approve"],{pair_code:"abcd123456",owner_id:"attacker"});
  assert.equal(app.writes[0].owner_id,"signed-in-owner");
  assert.ok(app.filters.some(([k,v])=>k==="owner_id"&&v===null));
});
test("another account cannot claim an approved device; expired and malformed codes are denied",async()=>{
  for(const app of [setup("another-owner"),setup(null,true)]) await assert.rejects(app.run("POST",["native-reminder-devices","approve"],{pair_code:"ABCD123456"}));
  await assert.rejects(setup().run("POST",["native-reminder-devices","approve"],{pair_code:"bad"}));
});
test("device removal is scoped to the current CRM owner",async()=>{
  const app=setup();await app.run("DELETE",["native-reminder-devices","device"]);
  assert.ok(app.filters.some(([k,v])=>k==="owner_id"&&v==="signed-in-owner"));
  assert.ok(app.writes[0].revoked_at);
});
