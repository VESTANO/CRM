import assert from 'node:assert/strict';
import test from 'node:test';
import { reminderWorkerUrl } from '../frontend/src/services/reminderPush.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
test('Pages reminder worker follows the configured repository base while Django keeps its root worker', () => {
  assert.equal(reminderWorkerUrl('/review-crm/'), '/review-crm/service-worker.js');
  assert.equal(reminderWorkerUrl('/CRM/'), '/CRM/service-worker.js');
  assert.equal(reminderWorkerUrl('/'), '/service-worker.js');
  assert.equal(reminderWorkerUrl('/static/frontend/'), '/service-worker.js');
});
test('real worker core resolves delivery payload paths within standard, custom, and root bases', async () => {
  const source = readFileSync(new URL('../frontend/public/reminder-worker-core.js', import.meta.url), 'utf8');
  const self = {};
  vm.runInNewContext(source, { self, URL, Date });
  for (const base of ['/CRM/', '/review-crm/', '/']) {
    const values = new Map(), opened = [];
    const worker = self.createReminderWorker({
      baseUrl: `https://example.test${base}`,
      storage: { get: async key => values.get(key), put: async (key, value) => values.set(key, value), remove: async key => values.delete(key), entries: async () => [] },
      showNotification: async () => {}, getNotifications: async () => [], fetchReceipt: async () => ({ ok: true }),
      clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
    });
    await worker.bind('owner-qa');
    await worker.click({ ownerId: 'owner-qa', reminderId: 7, url: '/CRM/reminders?reminder=7#reminder-7', path: 'reminders?reminder=7#reminder-7' });
    assert.deepEqual(opened, [`https://example.test${base}reminders?reminder=7#reminder-7`]);
  }
});
