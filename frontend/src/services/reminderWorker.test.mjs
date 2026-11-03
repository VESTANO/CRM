import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../../public/reminder-worker-core.js", import.meta.url), "utf8");
function device({ records = new Map(), open = false, offline = false, baseUrl = "https://vestano.github.io/CRM/" } = {}) {
  const shown = [], opened = [], receipts = [];
  const self = {};
  vm.runInNewContext(code, { self, URL, Date });
  const storage = { get: async (k) => records.get(k), put: async (k, v) => records.set(k, v), remove: async (k) => records.delete(k), entries: async () => [...records].map(([key, value]) => ({ key, value })) };
  const clients = { matchAll: async () => open ? [{ url: baseUrl + 'sales', navigate: async (u) => opened.push(u), focus: async () => {} }] : [], openWindow: async (u) => opened.push(u) };
  const worker = self.createReminderWorker({ storage, clients, baseUrl,
    showNotification: async (...args) => shown.push(args), getNotifications: async () => [],
    fetchReceipt: async (u, body) => { if (offline) throw new Error("offline"); receipts.push(body.event); return { ok: true }; },
  });
  return { worker, shown, opened, receipts, records };
}
const payload = { reminderId: 8, notificationKey: "8:1", ownerId: "user-1", body: "Reminder test", path: "reminders?reminder=8#reminder-8", receipt: { token: "a".repeat(43), url: "https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/reminder-receipt" } };

for (const open of [true, false]) test(`Service Worker displays without page timers; CRM ${open ? 'open on another page' : 'closed'}`, async () => {
  const d = device({ open }); await d.worker.bind("user-1"); await d.worker.push(payload);
  assert.equal(d.shown.length, 1); assert.deepEqual(d.receipts, ["received", "displayed"]);
  await d.worker.click(payload); assert.equal(d.opened[0], "https://vestano.github.io/CRM/reminders?reminder=8#reminder-8");
});
test("worker restart retains deduplication even after notification dismissal", async () => {
  const d = device(); await d.worker.bind("user-1"); await d.worker.push(payload);
  const restarted = device({ records: d.records }); await restarted.worker.push(payload);
  assert.equal(restarted.shown.length, 0);
  await restarted.worker.push({ ...payload, notificationKey: "8:2", tag: "rescheduled" });
  assert.equal(restarted.shown.length, 1);
});
test("simulated closed browser receives a queued push after its runtime returns", async () => {
  const durable = new Map([['owner', 'user-1']]);
  // No worker runtime exists while fully exited. The push service holds the message.
  const providerQueue = [payload];
  const reopened = device({ records: durable });
  await reopened.worker.push(providerQueue.shift());
  assert.equal(reopened.shown.length, 1);
});
test("offline receipt retries survive worker termination without a duplicate alert", async () => {
  const d = device({ offline: true }); await d.worker.bind("user-1"); await d.worker.push(payload);
  assert.equal(d.shown.length, 1); assert.equal(d.receipts.length, 0);
  const online = device({ records: d.records }); await online.worker.flush();
  assert.deepEqual(online.receipts, ["received", "displayed"]);
  await online.worker.push(payload); assert.equal(online.shown.length, 0);
});
test("signed-out or switched users do not receive another user's reminders", async () => {
  const d = device(); await d.worker.bind("user-2"); await d.worker.push(payload);
  assert.equal(d.shown.length, 0); assert.equal(d.receipts.length, 0);
  await d.worker.bind(null); await d.worker.push(payload); assert.equal(d.shown.length, 0);
});
test("an obsolete queued push is rejected after rescheduling", async () => {
  const self = {}, records = new Map([['owner', 'user-1']]), shown = [];
  vm.runInNewContext(code, { self, URL, Date });
  const worker = self.createReminderWorker({ baseUrl: "https://vestano.github.io/CRM/",
    storage: { get: async (k) => records.get(k), put: async (k,v) => records.set(k,v), remove: async (k) => records.delete(k), entries: async () => [] },
    getNotifications: async () => [], showNotification: async (p) => shown.push(p), clients: {},
    fetchReceipt: async () => ({ ok: false, status: 404 }),
  });
  await worker.push(payload); assert.equal(shown.length, 0);
});
test("expired queued pushes are suppressed and notification links stay in the correct app scope", async () => {
  const d = device({ baseUrl: "http://localhost:5173/" }); await d.worker.bind("user-1");
  await d.worker.push({ ...payload, expiresAt: "2000-01-01T00:00:00Z" }); assert.equal(d.shown.length, 0);
  await d.worker.click(payload); assert.equal(d.opened[0], "http://localhost:5173/reminders?reminder=8#reminder-8");
  await d.worker.click({ ...payload, path: "https://evil.test/" }); assert.equal(d.opened[1], "http://localhost:5173/reminders?reminder=8#reminder-8");
});
