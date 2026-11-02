import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { attendanceSupabase, getAttendanceSession, signInAttendance } from "../services/attendanceSupabase.js";

const AttendanceAuthContext = createContext(null);

export function AttendanceAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [permission, setPermission] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const restore = async () => {
    try {
      const restored = await getAttendanceSession();
      setSession(restored.session); setProfile(restored.profile); setPermission(restored.permission); setError("");
    } catch (restoreError) {
      setSession(null); setProfile(null); setPermission(null); setError(restoreError.message);
    } finally { setIsLoading(false); }
  };

  useEffect(() => {
    restore();
    const { data: listener } = attendanceSupabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "SIGNED_OUT") { setSession(null); setProfile(null); setPermission(null); return; }
      if (nextSession) setSession(nextSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const login = async (identity, password) => {
    setIsLoading(true); setError("");
    try { const result = await signInAttendance(identity, password); setSession(result.session); setProfile(result.profile); setPermission(result.permission); if (!result.permission.allowed) throw new Error(result.permission.message); return result; }
    catch (loginError) { setError(loginError.message); throw loginError; }
    finally { setIsLoading(false); }
  };
  const logout = async () => { await attendanceSupabase.auth.signOut(); setSession(null); setProfile(null); setPermission(null); };
  const value = useMemo(() => ({ session, profile, permission, isLoading, error, login, logout, restore }), [session, profile, permission, isLoading, error]);
  return <AttendanceAuthContext.Provider value={value}>{children}</AttendanceAuthContext.Provider>;
}

export function useAttendanceAuth() {
  const context = useContext(AttendanceAuthContext);
  if (!context) throw new Error("useAttendanceAuth must be used inside AttendanceAuthProvider");
  return context;
}
