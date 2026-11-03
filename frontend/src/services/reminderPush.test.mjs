import assert from "node:assert/strict";
import test from "node:test";
import { bindReminderRegistration, clearReminderDevice, prepareReminderNotifications, reminderWorkerUrl, saveReminderWithNotifications, syncReminderPush } from "./reminderPush.js";

test("device binding completes before saving a subscription; logout clears only the CRM device", async () => {
  const messages = [], removed = [];
  const registration = { scope: "https://example.test/CRM/", active: {
    postMessage: (message, ports) => { messages.push(message); ports[0].postMessage({ ok: true }); },
  }, pushManager: { getSubscription: async () => ({ endpoint: "registered-device" }) } };
  await bindReminderRegistration(registration, "owner-1");
  await clearReminderDevice({ serviceWorker: { getRegistration: async () => registration }, workerUrl: "/CRM/service-worker.js", removeSubscription: async (endpoint) => removed.push(endpoint) });
  assert.deepEqual(messages.map((m) => m.ownerId), ["owner-1", null]);
  assert.deepEqual(removed, ["registered-device"]);
  await clearReminderDevice({ serviceWorker: { getRegistration: async () => ({ ...registration, scope: "https://example.test/" }) }, workerUrl: "/CRM/service-worker.js", removeSubscription: () => assert.fail("Unrelated app registration") });
});

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
