import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
import {PGlite} from '../../../frontend/node_modules/@electric-sql/pglite/dist/index.js';

const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''));
const profile={id:'user-1',employee_id:'EMP_01',email:'employee@example.test',active:true};
function fixture({profiles=[profile],legacy=[],cooldown=false,linkError=false,mailError=false,queryError=false,missingConfig=false}={}){
  const reads=[],mail=[],links=[],writes=[],logs=[],claims=new Set();let handler;
  const client={
    rpc:async(name,values)=>{
      if(name==='crm_password_reset_profile'){
        reads.push({name,values});if(queryError)return {error:new Error('Database unavailable')};
        const identity=values.p_identity.trim().toLowerCase();
        const usernames=profiles.filter(p=>p.employee_id.toLowerCase()===identity);
        const emails=profiles.filter(p=>p.email.toLowerCase()===identity);
        const aliases=legacy.filter(l=>l.is_active&&l.original_email.toLowerCase()===identity).flatMap(l=>profiles.filter(p=>p.id===l.auth_user_id));
        return {data:usernames.length?usernames:emails.length?emails:aliases};
      }
      assert.equal(name,'crm_claim_password_reset');writes.push({name,payload:values});
      const allowed=!cooldown&&!claims.has(values.p_email_hash);claims.add(values.p_email_hash);
      return {data:allowed,error:null};
    },
    auth:{admin:{generateLink:async values=>{links.push(values);return linkError?{error:new Error('Auth provider unavailable')}:{data:{properties:{action_link:'https://local.test/recovery?token=synthetic'}}};}}},
    from:()=>{throw new Error('Reset handler must use its private resolver/claim RPCs.');},
  };
  const env={SUPABASE_URL:'https://local.test',SUPABASE_SERVICE_ROLE_KEY:'private-test-key',BREVO_API_KEY:'private-test-mail-key',BREVO_SENDER_EMAIL:'sender@example.test'};
  new Function('createClient','corsHeaders','Deno','fetch','console',source)(()=>client,{'Access-Control-Allow-Origin':'*'},
    {env:{get:key=>missingConfig?'':env[key]||''},serve:value=>{handler=value;}},
    async(url,values)=>{assert.equal(url,'https://api.brevo.com/v3/smtp/email');mail.push(JSON.parse(values.body));return {ok:!mailError,status:mailError?503:201};},
    {error:(...values)=>logs.push(values)});
  const request=async(identity,method='POST')=>{
    const response=await handler(new Request('http://local.test/password-reset',{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({identity})}:{})}));
    return {status:response.status,data:await response.json()};
  };
  return {request,reads,mail,links,writes,logs};
}
test('known, unknown, inactive, cooling-down and provider-failure responses do not enumerate an account',async()=>{
  const responses=[];
  for(const options of [{},{profiles:[]},{profiles:[{...profile,active:false}]},{cooldown:true},{linkError:true},{mailError:true},{queryError:true}]){
    const app=fixture(options);responses.push(await app.request('EMP_01'));
  }
  assert.deepEqual(responses,Array.from({length:responses.length},()=>({status:200,data:{ok:true}})));
});
test('active username delivery uses the real recovery callback, correct recipient, and hashed cooldown record',async()=>{
  const app=fixture();await app.request('EMP_01');
  assert.equal(app.links.length,1);assert.equal(app.links[0].type,'recovery');
  assert.deepEqual(app.mail[0].to,[{email:profile.email}]);
  assert.equal(app.writes.length,1);assert.match(app.writes[0].payload.p_email_hash,/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(app.writes).includes(profile.email),false);
});
test('username/email lookup is case-insensitive but wildcard characters remain literal',async()=>{
  const app=fixture({profiles:[profile,{...profile,id:'decoy',employee_id:'EMPX01',email:'decoy@example.test'}]});
  await app.request(' emp_01 ');assert.equal(app.mail.length,1);assert.equal(app.links[0].email,profile.email);
  assert.equal(app.reads[0].values.p_identity,'emp_01');
  await app.request('emp%');assert.equal(app.mail.length,1,'percent cannot match every employee');
  await app.request('emp*');assert.equal(app.mail.length,1,'asterisk cannot match every employee');
  const byEmail=fixture();await byEmail.request('EMPLOYEE@EXAMPLE.TEST');assert.equal(byEmail.mail.length,1);
});
test('legacy email aliases require the linked current profile to be active',async()=>{
  const alias={auth_user_id:profile.id,auth_email:'old-auth@example.test',original_email:'Old@Example.test',is_active:true};
  const app=fixture({legacy:[alias]});await app.request('old@example.test');assert.equal(app.mail.length,1);assert.equal(app.links[0].email,profile.email);
  const disabled=fixture({profiles:[{...profile,active:false}],legacy:[alias]});
  assert.deepEqual(await disabled.request('OLD@example.test'),{status:200,data:{ok:true}});assert.equal(disabled.links.length,0);assert.equal(disabled.mail.length,0);
  const orphaned=fixture({profiles:[],legacy:[alias]});await orphaned.request('old@example.test');assert.equal(orphaned.mail.length,0);
});
test('ambiguous case-folded usernames fail closed without a reset link or delivery claim',async()=>{
  const app=fixture({profiles:[profile,{...profile,id:'other',employee_id:'emp_01',email:'another@example.test'}]});
  assert.deepEqual(await app.request('EMP_01'),{status:200,data:{ok:true}});
  assert.equal(app.links.length,0);assert.equal(app.writes.length,0);assert.equal(app.mail.length,0);
});
test('uniform configuration failures, malformed identities and unsupported methods do not send mail',async()=>{
  const unavailable=fixture({missingConfig:true});
  assert.deepEqual(await unavailable.request('EMP_01'),await unavailable.request('UNKNOWN'));
  const app=fixture();for(const identity of ['', ' '.repeat(5),'A'.repeat(257)])assert.deepEqual(await app.request(identity),{status:200,data:{ok:true}});
  assert.equal((await app.request('', 'GET')).status,405);assert.equal(app.mail.length,0);
});
test('PostgreSQL cooldown admits one claim, expires safely, and denies public execution',async()=>{
  const db=new PGlite();
  try{
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec('create table profiles(id uuid primary key,employee_id text,email text,active boolean);create table crm_legacy_auth(auth_user_id uuid,original_email text,is_active boolean);');
    for(const name of ['202611060001_password_reset_requests','202611070009_atomic_password_reset_cooldown'])await db.exec(readFileSync(new URL(`../../migrations/${name}.sql`,import.meta.url),'utf8'));
    const claim=async(hash='a'.repeat(64))=>(await db.query('select crm_claim_password_reset($1) claimed',[hash])).rows[0].claimed;
    assert.deepEqual(await Promise.all([claim(),claim()]),[true,false]);
    assert.equal(await claim(),false);
    await db.exec("update crm_password_reset_requests set requested_at=now()-interval '61 seconds'");
    assert.equal(await claim(),true);assert.equal(await claim(),false);
    assert.equal(await claim('b'.repeat(64)),true);
    await assert.rejects(claim('plain-email@example.test'),/Invalid password-reset claim/);
    assert.equal((await db.query('select count(*) n from crm_password_reset_requests')).rows[0].n,2);
    await db.exec('set role authenticated');
    try{await assert.rejects(claim(),/permission denied/);await assert.rejects(db.query('select crm_password_reset_profile(\'EMP\')'),/permission denied/);await assert.rejects(db.query('select * from crm_password_reset_requests'),/permission denied/);}finally{await db.exec('reset role');}
    await db.exec("insert into profiles values('00000000-0000-4000-8000-000000000001','EMP_01','current@example.test',true),('00000000-0000-4000-8000-000000000002','EMPX01','other@example.test',true);insert into crm_legacy_auth values('00000000-0000-4000-8000-000000000001','Old@Example.test',true);");
    const resolve=async identity=>(await db.query('select * from crm_password_reset_profile($1)',[identity])).rows;
    assert.equal((await resolve(' emp_01 '))[0].email,'current@example.test');
    assert.equal((await resolve('CURRENT@EXAMPLE.TEST'))[0].email,'current@example.test');
    for(const identity of ['EMP%','EMP*','EMP_0_'])assert.deepEqual(await resolve(identity),[]);
    assert.equal((await resolve('old@example.test'))[0].email,'current@example.test');
    await db.exec("update profiles set active=false where employee_id='EMP_01'");
    assert.equal((await resolve('old@example.test'))[0].active,false);
    await db.exec("insert into profiles values('00000000-0000-4000-8000-000000000003','emp_01','case-collision@example.test',true)");
    assert.equal((await resolve('EMP_01')).length,2);
  }finally{await db.close();}
});
test('provider failure retains the atomic cooldown so immediate retry cannot flood delivery',async()=>{
  const app=fixture({mailError:true});
  await app.request('EMP_01');await app.request('EMP_01');
  assert.equal(app.links.length,1);assert.equal(app.mail.length,1);
});
