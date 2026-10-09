self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "A reminder is due." };
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Customer CRM", {
    body: payload.body || "A reminder is due.",
    icon: "/static/images/customer-crm.svg",
    badge: "/static/images/customer-crm.svg",
    tag: payload.tag || (payload.reminderId ? `crm-reminder-${payload.reminderId}` : "crm-reminder"),
    renotify: false,
    data: { url: payload.url || "/reminders/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/reminders/", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return clients.openWindow(target);
  }));
});
