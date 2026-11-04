import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const receiverSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  .replace(/^import \{ createClient \} from "npm:@supabase\/supabase-js@2";\s*/, '');
const bridgeSource = readFileSync(new URL('../../../scripts/attendance-device-bridge/supabase/functions/iclock/index.ts', import.meta.url), 'utf8');

function loadHandler(source, client, fetch = () => { throw new Error('Unexpected network request'); }) {
  let handler;
  const env = { ATTENDANCE_ALLOWED_SERIALS: 'TESTDEVICE', ATTENDANCE_TIMEZONE_OFFSET: '+05:30' };
  const deno = { env: { get: name => env[name] }, serve: value => { handler = value; } };
  new Function('createClient', 'Deno', 'fetch', stripTypeScriptTypes(source))(() => client, deno, fetch);
  return handler;
}

function receiver() {
  const writes = [];
  const client = { from: table => ({
    upsert: async value => { writes.push({ table, value }); return { error: null }; },
    select: () => ({ in: async () => ({ data: [], error: null }) }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }) };
  return { writes, handle: loadHandler(receiverSource, client) };
}

test('direct delivery records its route while retaining firmware compatibility and serial validation', async () => {
  const { writes, handle } = receiver();
  const reply = await handle(new Request('https://crm.example/iclock/iclock/cdata.aspx?SN=TESTDEVICE'));
  assert.equal(reply.status, 200);
  assert.match(await reply.text(), /^GET OPTION FROM: TESTDEVICE/);
  assert.equal(writes[0].value.last_ingest_route, 'direct');
  assert.ok(Number.isFinite(Date.parse(writes[0].value.last_seen)));

  const rejected = await handle(new Request('https://crm.example/iclock/iclock/cdata?SN=UNKNOWN'));
  assert.equal(rejected.status, 403);
  assert.equal(writes.length, 1);
});

test('legacy forwarding marks the actual receiver write and preserves punch content and acknowledgement', async () => {
  const { writes, handle } = receiver();
  const payload = '123\t2026-11-04 14:30:00\t0\t1';
  let forwarded;
  const bridge = loadHandler(bridgeSource, null, async (url, init) => {
    forwarded = new Request(url, init);
    return handle(forwarded);
  });
  const reply = await bridge(new Request('https://old.example/iclock/iclock/cdata?SN=TESTDEVICE&table=ATTLOG', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-attendance-route': 'direct' }, body: payload,
  }));
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), 'OK: 1');
  assert.equal(forwarded.url, 'https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock/iclock/cdata?SN=TESTDEVICE&table=ATTLOG');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.headers.get('x-attendance-route'), 'legacy-proxy');
  assert.equal(writes[0].value.last_ingest_route, 'legacy-proxy');
  assert.equal(writes[1].table, 'attendance_records');
  assert.equal(writes[1].value[0].raw, payload);
  assert.equal(writes[1].value[0].punched_at, '2026-11-04T09:00:00.000Z');
});

test('unsupported routes still perform no receiver writes or legacy forwarding', async () => {
  const { writes, handle } = receiver();
  assert.equal((await handle(new Request('https://crm.example/unsupported?SN=TESTDEVICE'))).status, 404);
  assert.equal(writes.length, 0);
  const bridge = loadHandler(bridgeSource, null);
  assert.equal((await bridge(new Request('https://old.example/iclock/unsupported?SN=TESTDEVICE'))).status, 404);
});
