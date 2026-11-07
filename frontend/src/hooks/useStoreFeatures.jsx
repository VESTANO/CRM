import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./useAuth.jsx";
import { activeStoreId } from "../services/storeContext.js";
import { invalidateApiCache, storeFeaturesApi } from "../services/api.js";
import { defaultStoreFeatures } from "../services/storeFeatures.js";

const StoreFeaturesContext = createContext(null);

export function StoreFeaturesProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const storeId = activeStoreId();
  const [state, setState] = useState({ key: "", features: defaultStoreFeatures, loading: true, error: false });
  const [revision, setRevision] = useState(0);
  const previous = useRef(null);
  const key = `${user?.id || ""}:${storeId}`;
  useEffect(() => {
    if (!user?.id || (user.is_superuser && !storeId)) {
      setState({ key, features: defaultStoreFeatures, loading: false, error: false });
      return;
    }
    let active = true;
    previous.current = null;
    setState({ key, features: defaultStoreFeatures, loading: true, error: false });
    const load = () => storeFeaturesApi.get({ fresh: true }).then(({ data }) => {
      if (!active) return;
      const next = { ...defaultStoreFeatures, ...data.features };
      if (previous.current && JSON.stringify(previous.current) !== JSON.stringify(next)) invalidateApiCache();
      previous.current = next;
      setState((current) => current.key === key && !current.loading && !current.error && JSON.stringify(current.features) === JSON.stringify(next)
        ? current : { key, features: next, loading: false, error: false });
    }).catch(() => {
      if (active) setState({ key, features: defaultStoreFeatures, loading: false, error: true });
    });
    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    window.addEventListener("focus", load);
    return () => { active = false; window.clearInterval(interval); window.removeEventListener("focus", load); };
  }, [key, user?.is_superuser, revision]);
  useEffect(() => {
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener("crm:store-features-updated", refresh);
    return () => window.removeEventListener("crm:store-features-updated", refresh);
  }, []);
  // Reading location causes the provider to detect a selected-store change
  // during navigation without relying on another global store of UI state.
  void location.pathname;
  const value = state.key === key ? state : { key, features: defaultStoreFeatures, loading: true, error: false };
  return <StoreFeaturesContext.Provider value={value}>{children}</StoreFeaturesContext.Provider>;
}

export function useStoreFeatures() {
  return useContext(StoreFeaturesContext) || { features: defaultStoreFeatures, loading: true, error: false };
}
