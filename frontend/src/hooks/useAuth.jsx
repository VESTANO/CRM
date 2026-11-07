import { remindersApi } from "../services/api.js";
import { clearReminderDevice, prepareReminderNotifications, reminderWorkerUrl } from "../services/reminderPush.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { authApi, setApiCacheScope } from "../services/api.js";
import { crmSupabase } from "../services/crmSupabase.js";

import { clearAttendanceReadCache } from "../services/attendanceSupabase.js";
import { clearSelectedStore } from "../services/storeContext.js";
import { withTimeout } from "../services/withTimeout.js";

const AuthContext = createContext(null);
const AUTH_TIMEOUT_MS = 15_000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const skipNextSignedInRefresh = useRef(false);
  const sessionVersion = useRef(0);
  const mounted = useRef(false);
  const refreshTimer = useRef();

  const refreshSession = useCallback(async () => {
    const version = ++sessionVersion.current;
    try {
      const { data } = await withTimeout(authApi.session(), AUTH_TIMEOUT_MS, "CRM session check timed out.");
      if (!mounted.current || version !== sessionVersion.current) return data;
      setApiCacheScope(data.user?.id);
      setUser(data.user);
      setCsrfToken(data.csrfToken || "");
      return data;
    } catch (error) {
      if (mounted.current && version === sessionVersion.current) {
        setApiCacheScope(null);
        setUser(null);
        setCsrfToken("");
      }
      throw error;
    } finally {
      // Route guards must always resolve, including when Supabase is offline.
      if (mounted.current && version === sessionVersion.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshSession().catch(() => {});
    const expireSession = () => {
      sessionVersion.current += 1;
      window.clearTimeout(refreshTimer.current);
      setApiCacheScope(null);
      setUser(null); setCsrfToken("");
      setIsLoading(false);
      clearAttendanceReadCache();
    };
    window.addEventListener("crm:session-expired", expireSession);
    const { data: authListener } = crmSupabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        expireSession();
        return;
      }
      if (["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"].includes(event)) {
        if (event === "SIGNED_IN" && skipNextSignedInRefresh.current) {
          skipNextSignedInRefresh.current = false;
          return;
        }
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => refreshSession().catch(() => {}), 0);
      }
    });
    return () => {
      mounted.current = false;
      sessionVersion.current += 1;
      window.clearTimeout(refreshTimer.current);
      window.removeEventListener("crm:session-expired", expireSession);
      authListener.subscription.unsubscribe();
    };
  }, [refreshSession]);

  const login = useCallback(async (credentials) => {
    // A selected workspace belongs to the previous browser session, never to
    // a newly signed-in account. Super Admins must begin at Stores.
    clearSelectedStore();
    const version = ++sessionVersion.current;
    window.clearTimeout(refreshTimer.current);
    skipNextSignedInRefresh.current = true;
    try {
      const { data } = await authApi.login(credentials);
      if (!mounted.current || version !== sessionVersion.current) return data;
      setApiCacheScope(data.user?.id);
      setUser(data.user);
      setCsrfToken(data.csrfToken || "");
      setIsLoading(false);
      return data;
    } catch (error) {
      skipNextSignedInRefresh.current = false;
      throw error;
    }
  }, []);

  useEffect(() => {
    if (isLoading || !("serviceWorker" in navigator)) return;
    const workerUrl = reminderWorkerUrl(import.meta.env.BASE_URL);
    if (!user?.id) {
      clearReminderDevice({ serviceWorker: navigator.serviceWorker, workerUrl, removeSubscription: async () => {} }).catch(() => {});
      return;
    }
    if (!("Notification" in window) || !("PushManager" in window) || Notification.permission !== "granted") return;
    prepareReminderNotifications({
      notification: Notification, serviceWorker: navigator.serviceWorker, workerUrl, ownerId: user.id,
      loadConfig: async () => (await remindersApi.pushConfig()).data,
      saveSubscription: (subscription) => remindersApi.subscribePush(subscription, ""),
    }).catch(() => {});
  }, [user?.id, isLoading]);

  const logout = useCallback(async () => {
    sessionVersion.current += 1;
    window.clearTimeout(refreshTimer.current);
    clearSelectedStore();
    setApiCacheScope(null);
    setUser(null);
    setCsrfToken("");
    setIsLoading(false);
    await authApi.logout();
  }, []);

  const value = useMemo(
    () => ({
      user,
      csrfToken,
      isLoading,
      isAuthenticated: Boolean(user),
      login,
      logout,
    }),
    [user, csrfToken, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}
