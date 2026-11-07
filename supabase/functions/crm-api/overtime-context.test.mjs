import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const serializer = stripTypeScriptTypes(source.slice(source.indexOf('async function serializeOvertime('), source.indexOf('async function handleOvertime(')));

test('overtime serialization receives its request scope and retains approved totals', async () => {
  const ctx = { user: { id: 'admin-a' }, profile: { role: 'admin', store_id: 'store-a' } };
  const serialize = new Function('adminUserById', 'profileName', 'overtimeContext', `${serializer}; return serializeOvertime;`)(
    async (received, id) => { assert.equal(received, ctx); assert.equal(id, 'employee-a'); return { id, employee_id: 'EMP-A', name: 'Employee A' }; },
    async () => 'Existing reviewer',
    async () => { throw new Error('Reviewed overtime must retain its stored punch'); },
  );
  const result = await serialize(ctx, { id: 1, employee_id: 'employee-a', status: 'approved', assigned_start_time: '09:00', assigned_end_time: '18:00', official_end_time: '18:05', approved_minutes: 75, requested_minutes: 90, actual_punch_out: '2026-11-07T14:00:00Z' });
  assert.equal(result.approvedMinutes, 75);
  assert.equal(result.actualPunchOut, '2026-11-07T14:00:00Z');
  assert.match(source, /requests\.map\(\(item: any\) => serializeOvertime\(ctx, item\)\)/);
  assert.match(source, /json\(201, await serializeOvertime\(ctx, data\)\)/);
  assert.match(source, /json\(200, await serializeOvertime\(ctx, data\)\)/);
});
