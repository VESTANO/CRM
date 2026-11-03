import assert from "node:assert/strict";
import test from "node:test";
import { dispatchDueReminders, trustedPushEndpoint } from "./reminder-delivery.ts";

function setup({ subscriptions = [{ id: 1, endpoint: "https://fcm.googleapis.com/test" }], deliveries = [], attempt = 1, current = true } = {}) {
  const reminder = { id: 7, owner_id: "owner", text: "Test reminder", delivery_attempt_count: attempt };
  const finished = [], saved = [], expired = [];
  const store = {
    claim: async () => [reminder], isCurrent: async () => current,
    prepareDelivery: async () => ({ id: 1, receiptToken: "test", receiptUrl: "https://example.test/receipt" }),
    subscriptions: async () => subscriptions, deliveries: async () => deliveries,
    expire: async (id) => expired.push(id),
    saveDelivery: async (...args) => saved.push(args),
    finish: async (...args) => finished.push(args[1]),
  };
  return { store, finished, saved, expired };
}

test("successful delivery uses the CRM route and records completion", async () => {
  const app = setup(), messages = [];
  const result = await dispatchDueReminders(app.store, async (s, payload) => messages.push(payload));
  assert.equal(result.sent, 1);
  assert.equal(messages[0].url, "/CRM/reminders?reminder=7#reminder-7");
  assert.equal(app.finished[0].delivery_status, "sent");
  assert.ok(app.finished[0].sent_at);
});
test("retry skips devices that already accepted the same reminder", async () => {
  const app = setup({ deliveries: [{ subscription_id: 1, status: "accepted" }] });
  await dispatchDueReminders(app.store, async () => assert.fail("Duplicate push"));
  assert.equal(app.finished[0].delivery_status, "sent");
});
test("temporary push failures retry without storing provider data", async () => {
  const app = setup();
  await dispatchDueReminders(app.store, async () => { throw Object.assign(new Error("private endpoint secret"), { statusCode: 503 }); });
  assert.equal(app.finished[0].delivery_status, "retrying");
  assert.ok(app.finished[0].next_delivery_attempt_at);
  assert.equal(app.saved[0][3], "Push service returned HTTP 503.");
});
test("expired subscriptions are removed and do not prevent another device receiving", async () => {
  const app = setup({ subscriptions: [{ id: 1, endpoint: "https://fcm.googleapis.com/a" }, { id: 2, endpoint: "https://fcm.googleapis.com/b" }] });
  await dispatchDueReminders(app.store, async (s) => { if (s.id === 1) throw { statusCode: 410 }; });
  assert.deepEqual(app.expired, [1]);
  assert.equal(app.finished[0].delivery_status, "sent");
});
test("missing devices wait for registration; failures stop after the attempt limit", async () => {
  const app = setup({ subscriptions: [] });
  await dispatchDueReminders(app.store, async () => assert.fail("No device"));
  assert.equal(app.finished[0].delivery_status, "no_subscriptions");
  const lastAttempt = setup({ attempt: 10 });
  await dispatchDueReminders(lastAttempt.store, async () => { throw { statusCode: 503 }; });
  assert.equal(lastAttempt.finished[0].delivery_status, "failed");
});
test("cancelled or rescheduled claims do not send or overwrite the reminder", async () => {
  const app = setup({ current: false });
  await dispatchDueReminders(app.store, async () => assert.fail("Stale reminder"));
  assert.equal(app.finished.length, 0);
});
test("only known HTTPS push services may receive reminder payloads", () => {
  for (const url of ["http://fcm.googleapis.com/a", "https://localhost/a", "https://127.0.0.1/", "https://fcm.googleapis.com.evil.test/", "https://user:pass@fcm.googleapis.com/a", "https://fcm.googleapis.com:8080/a"]) assert.equal(trustedPushEndpoint(url), false);
  assert.equal(trustedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/test"), true);
});
