import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {createAttendanceRelay,upstreamUrl} from './attendance-relay.mjs';

test('forwards device and legacy .aspx routes directly to CRM while preserving query values',()=>{
  assert.equal(upstreamUrl('/iclock/cdata.aspx?SN=device&table=ATTLOG'),'https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock/iclock/cdata?SN=device&table=ATTLOG');
  assert.ok(upstreamUrl('/iclock/getrequest?SN=device').includes('qdtgrddhpbwrutvojpes'));
  assert.equal(upstreamUrl('/other'),null);
  assert.equal(upstreamUrl('/iclock/cdata/../../admin'),null);
});
test('device receives the cloud response and gets a retry status when cloud storage fails',async t=>{
  let outage=false;
  const server=createAttendanceRelay(async(url,options)=>{
    assert.ok(url.startsWith('https://qdtgrddhpbwrutvojpes.supabase.co/'));
    assert.equal(options.body.toString(),'original punch body');
    if(outage) throw new Error('offline');
    return new Response('OK: 1',{status:200});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/iclock/cdata.aspx?SN=device&table=ATTLOG`;
  const success=await fetch(url,{method:'POST',body:'original punch body'});
  assert.equal(await success.text(),'OK: 1');
  outage=true;
  const failure=await fetch(url,{method:'POST',body:'original punch body'});
  assert.equal(failure.status,503);
  assert.match(await failure.text(),/retry/);
});
