const key = "crm-super-admin-store";
export const STORE_CHANGED_EVENT = "crm:store-changed";
const listeners = new Set();
export function subscribeStore(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function changed() {
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORE_CHANGED_EVENT));
}

export function activeStoreId() { return sessionStorage.getItem(key) || ""; }
export function selectStore(id) { if (activeStoreId() === id) return; sessionStorage.setItem(key, id); changed(); }
export function clearSelectedStore() { if (!activeStoreId()) return; sessionStorage.removeItem(key); changed(); }
