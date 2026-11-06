const key = "crm-super-admin-store";

export function activeStoreId() { return sessionStorage.getItem(key) || ""; }
export function selectStore(id) { sessionStorage.setItem(key, id); }
export function clearSelectedStore() { sessionStorage.removeItem(key); }
