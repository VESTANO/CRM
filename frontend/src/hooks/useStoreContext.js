import { useSyncExternalStore } from "react";
import { activeStoreId, subscribeStore } from "../services/storeContext.js";

export function useStoreContext() {
  return useSyncExternalStore(subscribeStore, activeStoreId, () => "");
}
