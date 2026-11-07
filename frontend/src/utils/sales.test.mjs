import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSalesReportStats, filterSalesVisits } from './sales.js';
test('six-month sales reports use the CRM India month at the UTC boundary',()=>{
  const stats=buildSalesReportStats([{status:'converted',expense:'0.10',visit_date:'2026-11-01'},{status:'healthy',expense:'0.20',visit_date:'2026-10-31'}],new Date('2026-10-31T19:00:00Z'));
  assert.deepEqual(stats.recentMonths.map(m=>m.key),['2026-06','2026-07','2026-08','2026-09','2026-10','2026-11']);
  assert.equal(stats.recentMonths.at(-1).count,1);assert.equal(stats.totalExpenses,0.3);assert.equal(stats.totalVisits,2);
});
test('sales report year rollover and status/name/dataset filters remain correct',()=>{
  const visits=[{client_name:'Alice',dataset_name:'West',payment_status:'completed',status:'converted',expense:'2.75',visit_date:'2026-12-31'},{client_name:'Bob',dataset_name:'East',status:'healthy',expense:'1.25',visit_date:'2027-01-01'}];
  assert.deepEqual(filterSalesVisits(visits,{q:'AL',dataset_name:'west',payment_status:'completed'}),[visits[0]]);
  const stats=buildSalesReportStats(visits,new Date('2026-12-31T19:00:00Z'));
  assert.equal(stats.recentMonths.at(-1).key,'2027-01');assert.equal(stats.recentMonths.at(-1).count,1);assert.equal(stats.totalExpenses,4);
});
