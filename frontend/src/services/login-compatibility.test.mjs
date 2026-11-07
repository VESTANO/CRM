import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source=readFileSync(new URL('./api.js',import.meta.url),'utf8');
const start=source.indexOf('  login: async (credentials)');
const loginSource=source.slice(start,source.indexOf('  requestPasswordReset:',start));

function fixture(status=401,correct=true) {
  const calls=[];
  const user={id:'store-user',store_id:'store-a',is_admin:false};
  const error=message=>Object.assign(new Error(message),{response:{status:401,data:{detail:message}}});
  const supabase={rpc:async()=>({data:'person@example.test'}),auth:{
    signInWithPassword:async values=>{calls.push(values);return correct?{data:{user:{id:user.id}}}:{error:{message:'Invalid login credentials'}};},
    setSession:async()=>({error:null}),
  }};
  const login=new Function('apiClient','crmSupabase','currentCrmUser','apiError',`return ({${loginSource}}).login;`)(
    {post:async()=>{throw Object.assign(new Error('No matching legacy credential'),{response:{status}});}},supabase,async()=>user,error,
  );
  return {login,calls};
}

test('new store usernames and email logins fall through legacy 401/404 to their existing Supabase password',async()=>{
  for(const status of [401,404]) for(const username of ['STORE_ADMIN01','person@example.test']) {
    const app=fixture(status); const result=await app.login({username,password:'Synthetic-password-only'});
    assert.equal(result.data.user.id,'store-user');
    assert.deepEqual(app.calls,[{email:'person@example.test',password:'Synthetic-password-only'}]);
  }
});
test('wrong passwords remain rejected and server failures never start a fallback login',async()=>{
  await assert.rejects(fixture(401,false).login({username:'STORE_USER01',password:'Wrong-password'}));
  const app=fixture(503);await assert.rejects(app.login({username:'STORE_USER01',password:'Synthetic-password-only'}));assert.equal(app.calls.length,0);
});
