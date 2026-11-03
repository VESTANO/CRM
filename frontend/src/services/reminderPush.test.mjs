import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { prepareReminderNotifications, reminderWorkerUrl, saveReminderWithNotifications, syncReminderPush } from "./reminderPush.js";

test("setting a reminder requests permission immediately, then registers before saving", async () => {
  const order = [];
  const options = {
    notification: { permission: "default", requestPermission: async () => { order.push("permission"); return "granted"; } },
    serviceWorker: { register: async () => ({ active: {}, pushManager: {
      getSubscription: async () => ({ toJSON: () => ({ endpoint: "test" }) }),
    } }) },
    workerUrl: "/CRM/service-worker.js",
    loadConfig: async () => { order.push("config"); return { publicKey: "AQID" }; },
    saveSubscription: async () => order.push("subscription"),
  };
  const result = saveReminderWithNotifications({ prepareNotifications: () => prepareReminderNotifications(options), saveReminder: async () => order.push("reminder") });
  assert.deepEqual(order, ["permission"]);
  assert.deepEqual(await result, { notificationError: "" });
  assert.deepEqual(order, ["permission", "config", "subscription", "reminder"]);
});
test("saved browser permission is reused with no extra prompt", async () => {
  await prepareReminderNotifications({
    notification: { permission: "granted", requestPermission: () => assert.fail("Repeated permission prompt") },
    serviceWorker: { register: async () => ({ active: {}, pushManager: { getSubscription: async () => ({ toJSON: () => ({ endpoint: "test" }) }) } }) },
    workerUrl: "/CRM/service-worker.js", loadConfig: async () => ({ publicKey: "AQID" }), saveSubscription: async () => {},
  });
});
test("blocked, dismissed, and unsupported notifications save the reminder with a warning", async () => {
  for (const permission of ["denied", "default", "unsupported"]) {
    let saved = 0;
    const { notificationError } = await saveReminderWithNotifications({
      prepareNotifications: () => prepareReminderNotifications({
        notification: permission === "unsupported" ? null : { permission, requestPermission: async () => "default" },
        serviceWorker: {}, loadConfig: () => assert.fail("Config should not load without permission"),
      }),
      saveReminder: async () => saved++,
    });
    assert.equal(saved, 1);
    assert.ok(notificationError);
  }
});
test("subscription failure cannot claim alerts are enabled, and reminder save failures still surface", async () => {
  const result = await saveReminderWithNotifications({ prepareNotifications: async () => { throw new Error("offline"); }, saveReminder: async () => {} });
  assert.equal(result.notificationError, "offline");
  await assert.rejects(saveReminderWithNotifications({ prepareNotifications: async () => {}, saveReminder: async () => { throw new Error("Save failed"); } }), /Save failed/);
});

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
