import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reminderWorkerUrl, syncReminderPush } from "./reminderPush.js";

test("Pages uses its deployed worker path; Django uses its root path", () => {
  assert.equal(reminderWorkerUrl("/CRM/"), "/CRM/service-worker.js");
  assert.equal(reminderWorkerUrl("/static/frontend/"), "/service-worker.js");
});
test("existing subscriptions are re-saved after a reload without creating a duplicate", async () => {
  const key = new Uint8Array([1, 2, 3]), saves = [];
  const subscription = { options: { applicationServerKey: key }, toJSON: () => ({ endpoint: "existing" }) };
  const serviceWorker = { register: async (url) => {
    assert.equal(url, "/CRM/service-worker.js");
    return { active: {}, pushManager: { getSubscription: async () => subscription, subscribe: async () => assert.fail("Duplicate") } };
  } };
  await syncReminderPush({ serviceWorker, publicKey: "AQID", workerUrl: "/CRM/service-worker.js", saveSubscription: async (s) => saves.push(s) });
  assert.deepEqual(saves, [{ endpoint: "existing" }]);
});
test("a changed key replaces the old subscription and a failed server save is not reported as enabled", async () => {
  let removed = false, created = false;
  const serviceWorker = { register: async () => ({ active: {}, pushManager: {
    getSubscription: async () => ({ options: { applicationServerKey: new Uint8Array([9]) }, unsubscribe: async () => { removed = true; } }),
    subscribe: async () => { created = true; return { toJSON: () => ({ endpoint: "new" }) }; },
  } }) };
  await assert.rejects(syncReminderPush({ serviceWorker, publicKey: "AQID", workerUrl: "/CRM/service-worker.js", saveSubscription: async () => { throw new Error("offline"); } }), /offline/);
  assert.ok(removed && created);
});
test("notification worker delivers after the page closes and stays inside the CRM scope", async () => {
  const handlers = {}, shown = [], opened = [];
  const self = { location: { href: "https://vestano.github.io/CRM/service-worker.js" }, addEventListener: (name, cb) => { handlers[name] = cb; },
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => [], openWindow: async (url) => opened.push(url) },
  };
  vm.runInNewContext(readFileSync(new URL("../../public/service-worker.js", import.meta.url), "utf8"), { self, URL });
  let work;
  handlers.push({ data: { json: () => ({ body: "Due", reminderId: 3 }) }, waitUntil: (promise) => { work = promise; } });
  await work;
  assert.equal(shown[0][1].body, "Due");
  assert.equal(shown[0][1].icon, "https://vestano.github.io/CRM/notification-icon.svg");
  handlers.notificationclick({ notification: { close() {}, data: { url: "https://evil.test/" } }, waitUntil: (promise) => { work = promise; } });
  await work;
  assert.equal(opened[0], "https://vestano.github.io/CRM/reminders");
});
