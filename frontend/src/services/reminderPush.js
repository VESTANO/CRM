export function reminderWorkerUrl(baseUrl) {
  return baseUrl === "/CRM/" ? "/CRM/service-worker.js" : "/service-worker.js";
}

export function decodeApplicationKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob((value + padding).replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
}

export async function syncReminderPush({ serviceWorker, publicKey, saveSubscription, workerUrl }) {
  const registration = await serviceWorker.register(workerUrl);
  if (!registration.active) {
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
