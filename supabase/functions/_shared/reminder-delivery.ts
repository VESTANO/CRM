export function trustedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (
      ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname)
      || /^jmt\d+\.google\.com$/.test(url.hostname)
      || url.hostname.endsWith(".notify.windows.com")
    );
  } catch { return false; }
}

export async function dispatchDueReminders(store: any, send: any, now = new Date()) {
  const reminders = await store.claim();
  const counts = { processed: 0, sent: 0, retrying: 0, noSubscriptions: 0, failed: 0 };
  for (const reminder of reminders) {
    if (!await store.isCurrent(reminder)) continue;
    const subscriptions = await store.subscriptions(reminder.owner_id);
    const deliveries = await store.deliveries(reminder.id);
    const accepted = new Set(deliveries.filter((row: any) => row.status === "accepted").map((row: any) => row.subscription_id));
    let failures = 0, acceptedCount = deliveries.filter((row: any) => row.status === "accepted").length;
    for (const subscription of subscriptions) {
      if (accepted.has(subscription.id)) continue;
      if (!await store.isCurrent(reminder)) break;
      let status = "accepted", lastError = "";
      try {
        if (!trustedPushEndpoint(subscription.endpoint)) throw Object.assign(new Error("Invalid push service endpoint"), { statusCode: 410 });
        await send(subscription, {
          title: "Customer CRM | Reminder", body: reminder.text,
          url: `/CRM/reminders?reminder=${reminder.id}#reminder-${reminder.id}`,
          tag: `crm-reminder-${reminder.id}`, reminderId: reminder.id,
        });
        acceptedCount++;
      } catch (error) {
        const code = Number((error as any)?.statusCode || 0);
        status = [404, 410].includes(code) ? "expired" : "failed";
        // Never persist endpoint URLs, keys, or push provider response bodies.
        lastError = code ? `Push service returned HTTP ${code}.` : "Push service connection failed.";
        if (status === "expired") await store.expire(subscription.id);
        else failures++;
      }
      const previous = deliveries.find((row: any) => row.subscription_id === subscription.id);
      await store.saveDelivery(reminder.id, subscription, status, lastError, (previous?.attempt_count || 0) + 1, now);
    }
    const state = failures ? (reminder.delivery_attempt_count >= 10 ? "failed" : "retrying") : acceptedCount ? "sent" : "no_subscriptions";
    const retryAt = ["retrying", "no_subscriptions"].includes(state)
      ? new Date(now.getTime() + (state === "no_subscriptions" ? 5 : Math.min(60, 2 ** Math.min(reminder.delivery_attempt_count, 5))) * 60000).toISOString() : null;
    await store.finish(reminder, {
      delivery_status: state, delivery_locked_at: null,
      sent_at: state === "sent" ? now.toISOString() : null,
      next_delivery_attempt_at: retryAt,
      last_delivery_error: state === "sent" ? "" : state === "no_subscriptions" ? "Enable browser notifications on a device to receive this reminder." : "Push delivery failed; retry scheduled if attempts remain.",
    });
    counts.processed++;
    if (state === "sent") counts.sent++;
    else if (state === "retrying") counts.retrying++;
    else if (state === "no_subscriptions") counts.noSubscriptions++;
    else counts.failed++;
  }
  return counts;
}
