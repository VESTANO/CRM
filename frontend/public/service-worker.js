importScripts("./reminder-worker-core.js");
const database = new Promise((resolve, reject) => {
  const r = indexedDB.open("crm-reminder-notifications", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("state", { keyPath: "key" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const operation = async (mode, action) => {
  const db = await database;
  return new Promise((resolve, reject) => {
    const t = db.transaction("state", mode), r = action(t.objectStore("state"));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};
const storage = {
  get: async (key) => (await operation("readonly", (s) => s.get(key)))?.value,
  put: (key, value) => operation("readwrite", (s) => s.put({ key, value })),
  remove: (key) => operation("readwrite", (s) => s.delete(key)),
  entries: () => operation("readonly", (s) => s.getAll()),
};
const worker = self.createReminderWorker({
  storage, baseUrl: new URL("./", self.location.href).href, clients: self.clients,
  showNotification: (...args) => self.registration.showNotification(...args),
  getNotifications: (options) => self.registration.getNotifications(options),
  fetchReceipt: (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", signal: AbortSignal.timeout(5000) }),
});
let queue = Promise.resolve();
const serialized = (action) => { const next = queue.then(action, action); queue = next.catch(() => {}); return next; };
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([self.clients.claim(), worker.prune(), worker.flush()])));
self.addEventListener("push", (e) => {
  let payload;
  try { payload = e.data?.json() || {}; } catch { payload = { body: "A reminder is due." }; }
  e.waitUntil(serialized(() => worker.push(payload)));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(serialized(() => worker.click(e.notification.data || {}))); });
self.addEventListener("message", (e) => {
  if (e.data?.type !== "CRM_REMINDER_BIND") return;
  e.waitUntil(serialized(async () => { await worker.bind(e.data.ownerId); e.ports[0]?.postMessage({ ok: true }); await worker.flush(); }));
});
