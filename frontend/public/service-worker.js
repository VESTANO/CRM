self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const base = new URL("./", self.location.href);
const reminderUrl = () => new URL("reminders", base);
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; }
  catch { payload = { body: event.data?.text() || "A reminder is due." }; }
  const icon = base.pathname === "/" ? "/static/images/customer-crm.svg" : new URL("notification-icon.svg", base).href;
  event.waitUntil(self.registration.showNotification(payload.title || "Customer CRM | Reminder", {
    body: payload.body || "A reminder is due.", icon, badge: icon,
    tag: payload.tag || `crm-reminder-${payload.reminderId || "due"}`, renotify: false,
    data: { url: payload.url || reminderUrl().href },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = reminderUrl();
  try {
    const requested = new URL(event.notification.data?.url || target.href, base);
    if (requested.origin === base.origin && requested.pathname.startsWith(base.pathname)) target = requested;
  } catch { /* Use the reminder page for malformed links. */ }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
    const existing = windows.find((client) => client.url.startsWith(base.href));
    if (existing) { await existing.navigate(target.href); return existing.focus(); }
    return self.clients.openWindow(target.href);
  }));
});
