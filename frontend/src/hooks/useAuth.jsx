import { remindersApi } from "../services/api.js";
import { clearReminderDevice, prepareReminderNotifications, reminderWorkerUrl } from "../services/reminderPush.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { authApi, setApiCacheScope } from "../services/api.js";
import { crmSupabase } from "../services/crmSupabase.js";

import { clearAttendanceReadCache } from "../services/attendanceSupabase.js";

const AuthContext = createContext(null);
const AUTH_TIMEOUT_MS = 15_000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error("CRM session check timed out.")), AUTH_TIMEOUT_MS)),
  ]);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const skipNextSignedInRefresh = useRef(false);

  const refreshSession = useCallback(async () => {
    try {
      const { data } = await withTimeout(authApi.session());
      setApiCacheScope(data.user?.id);
      setUser(data.user);
      setCsrfToken(data.csrfToken || "");
      return data;
    } finally {
      // Route guards must always resolve, including when Supabase is offline.
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSession().catch(() => {
      setUser(null);
      setIsLoading(false);
    });
    const expireSession = () => {
      setApiCacheScope(null);
      setUser(null); setCsrfToken("");
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
        window.setTimeout(() => refreshSession().catch(expireSession), 0);
      }
    });
    return () => {
      window.removeEventListener("crm:session-expired", expireSession);
      authListener.subscription.unsubscribe();
    };
  }, [refreshSession]);

  const login = useCallback(async (credentials) => {
    skipNextSignedInRefresh.current = true;
    try {
      const { data } = await authApi.login(credentials);
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
    await authApi.logout();
    setApiCacheScope(null);
    setUser(null);
    setCsrfToken("");
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
