import assert from 'node:assert/strict';
import test from 'node:test';
import { indiaDateInput, indiaDateTimeInput, indiaInputTimestamp } from './indiaTime.js';
test('overtime date and time use the same IST day across UTC midnight boundaries',()=>{
  const date=new Date('2026-11-06T20:00:00Z');
  assert.equal(indiaDateInput(date),'2026-11-07');
  assert.equal(indiaDateTimeInput(date),'2026-11-07T01:30');
  assert.equal(indiaInputTimestamp('2026-11-07T19:30'),'2026-11-07T14:00:00.000Z');
});
