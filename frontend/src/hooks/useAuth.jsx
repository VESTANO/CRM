import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authApi } from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const refreshSession = async () => {
    const { data } = await authApi.session();
    setUser(data.user);
    setCsrfToken(data.csrfToken || "");
    setIsLoading(false);
    return data;
  };

  useEffect(() => {
    refreshSession().catch(() => {
      setUser(null);
      setIsLoading(false);
    });
    const expireSession = () => setUser(null);
    window.addEventListener("crm:session-expired", expireSession);
    return () => window.removeEventListener("crm:session-expired", expireSession);
  }, []);

  const login = async (credentials) => {
    await authApi.login(credentials, csrfToken);
    return refreshSession();
  };

  const logout = async () => {
    await authApi.logout(csrfToken);
    setUser(null);
    await refreshSession();
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
