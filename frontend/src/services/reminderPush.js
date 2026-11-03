export function reminderWorkerUrl(baseUrl) {
  return baseUrl === "/CRM/" ? "/CRM/service-worker.js" : "/service-worker.js";
}

export function decodeApplicationKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob((value + padding).replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
}

export async function prepareReminderNotifications({ notification, serviceWorker, loadConfig, saveSubscription, workerUrl, ownerId }) {
  if (ownerId && typeof window !== "undefined" && window.localStorage.getItem("crm:native-reminder-owner") === ownerId) return { native: true };
  if (!notification || !serviceWorker) throw new Error("This browser does not support desktop reminder notifications.");
  // Request from the Set Reminder click, before network requests can consume
  // the browser's user activation. Saved permission needs no second prompt.
  const permission = notification.permission === "default" ? await notification.requestPermission() : notification.permission;
  if (permission !== "granted") throw new Error(permission === "denied"
    ? "Desktop notifications are blocked in your browser settings."
    : "Allow the browser notification prompt to receive desktop reminders.");
  const { publicKey } = await loadConfig();
  return syncReminderPush({ serviceWorker, publicKey, saveSubscription, workerUrl, ownerId });
}

export async function saveReminderWithNotifications({ prepareNotifications, saveReminder }) {
  let notificationError = "";
  try { await prepareNotifications(); }
  catch (error) { notificationError = error.response?.data?.detail || error.message || "Desktop notifications could not be connected."; }
  await saveReminder();
  return { notificationError };
}

export async function bindReminderRegistration(registration, ownerId) {
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error) => { clearTimeout(timeout); channel.port1.close(); channel.port2.close(); if (error) reject(error); else resolve(); };
    const timeout = setTimeout(() => finish(new Error("Notification worker is updating. Refresh and retry.")), 15000);
    channel.port1.onmessage = (event) => event.data?.ok ? finish() : finish(new Error("Unable to bind notifications to this account."));
    registration.active.postMessage({ type: "CRM_REMINDER_BIND", ownerId }, [channel.port2]);
  });
}

export async function clearReminderDevice({ serviceWorker, workerUrl, removeSubscription }) {
  const registration = await serviceWorker?.getRegistration(workerUrl);
  if (!registration?.active || new URL(registration.scope).pathname !== workerUrl.slice(0, workerUrl.lastIndexOf("/") + 1)) return;
  let bindingError;
  try { await bindReminderRegistration(registration, null); }
  catch (error) { bindingError = error; }
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await removeSubscription(subscription.endpoint);
  if (bindingError) throw bindingError;
}

export async function syncReminderPush({ serviceWorker, publicKey, saveSubscription, workerUrl, ownerId }) {
  const registration = await serviceWorker.register(workerUrl, { updateViaCache: "none" });
  if (registration.installing || !registration.active) {
    const worker = registration.installing || registration.waiting;
    if (!worker) throw new Error("Notification service is not ready. Please retry.");
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Notification service timed out. Please retry.")), 15000);
      const changed = () => {
        if (worker.state === "activated" || worker.state === "redundant") {
          clearTimeout(timeout);
          worker.removeEventListener("statechange", changed);
          if (worker.state === "activated") resolve();
          else reject(new Error("Notification service could not start. Please retry."));
        }
      };
      worker.addEventListener("statechange", changed);
      changed();
    });
  }
  if (ownerId !== undefined) await bindReminderRegistration(registration, ownerId);
  const applicationServerKey = decodeApplicationKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription?.options?.applicationServerKey) {
    const currentKey = new Uint8Array(subscription.options.applicationServerKey);
    if (currentKey.length !== applicationServerKey.length || currentKey.some((value, index) => value !== applicationServerKey[index])) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await saveSubscription(subscription.toJSON());
  return subscription;
}
