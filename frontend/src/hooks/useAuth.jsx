import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authApi } from "../services/api.js";
import { crmSupabase } from "../services/crmSupabase.js";

import { attendanceSupabase, runAttendanceAuthTask } from "../services/attendanceSupabase.js";

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

  const refreshSession = async () => {
    try {
      const { data } = await withTimeout(authApi.session());
      setUser(data.user);
      setCsrfToken(data.csrfToken || "");
      return data;
    } finally {
      // Route guards must always resolve, including when Supabase is offline.
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refreshSession().catch(() => {
      setUser(null);
      setIsLoading(false);
    });
    const expireSession = () => {
      setUser(null); setCsrfToken("");
      runAttendanceAuthTask(() => attendanceSupabase.auth.signOut({ scope: "local" })).catch(() => {});
    };
    window.addEventListener("crm:session-expired", expireSession);
    const { data: authListener } = crmSupabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        expireSession();
        return;
      }
      if (["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"].includes(event)) {
        window.setTimeout(() => refreshSession().catch(expireSession), 0);
      }
    });
    return () => {
      window.removeEventListener("crm:session-expired", expireSession);
      authListener.subscription.unsubscribe();
    };
  }, []);

  const login = async (credentials) => {
    await authApi.login(credentials);
    return refreshSession();
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
    setCsrfToken("");
  };

  const value = useMemo(
    () => ({
      user,
      csrfToken,
      isLoading,
      isAuthenticated: Boolean(user),
      login,
      logout,
    }),
    [user, csrfToken, isLoading]
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
