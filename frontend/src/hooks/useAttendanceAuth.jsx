import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { attendanceSupabase, clearAttendanceReadCache, getAttendanceSession } from "../services/attendanceSupabase.js";
import { useAuth } from "./useAuth.jsx";

const AttendanceAuthContext = createContext(null);
const emptyAccess = { session: null, profile: null, permission: null, owner: null };

export function AttendanceAuthProvider({ children }) {
  const { user, isLoading: crmLoading, logout } = useAuth();
  const [access, setAccess] = useState(emptyAccess);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const restore = useCallback(async () => {
    const request = ++generation.current;
    setAccess(emptyAccess);
    setIsLoading(true); setError("");
    try {
      if (!user?.id) return false;
      const restored = await getAttendanceSession();
      if (request !== generation.current) return false;
      if (restored.session?.user?.id !== user.id) return false;
      if (!restored.profile || !restored.permission?.allowed) throw new Error(restored.permission?.message || "Attendance access is unavailable.");
      setAccess({ ...restored, owner: user.id });
      return true;
    } catch (restoreError) {
      if (request === generation.current) setError(restoreError.response?.data?.detail || restoreError.message || "Unable to open attendance.");
      return false;
    } finally {
      if (request === generation.current) setIsLoading(false);
    }
  }, [user?.id]);
  useEffect(() => {
    restore();
    return () => { generation.current += 1; };
  }, [restore]);
  useEffect(() => {
    const { data } = attendanceSupabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        generation.current += 1;
        clearAttendanceReadCache();
        setAccess(emptyAccess);
        setError("");
        setIsLoading(false);
      }
      // Defer reads until the Supabase auth event has released its lock.
      if (event === "USER_UPDATED") window.setTimeout(() => restore(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [restore]);
  const value = useMemo(() => ({ ...(access.owner === user?.id ? access : emptyAccess), isLoading: crmLoading || isLoading, error, restore, logout }), [access, user?.id, crmLoading, isLoading, error, restore, logout]);
  return <AttendanceAuthContext.Provider value={value}>{children}</AttendanceAuthContext.Provider>;
}

export function useAttendanceAuth() {
  const context = useContext(AttendanceAuthContext);
  if (!context) throw new Error("useAttendanceAuth must be used inside AttendanceAuthProvider");
  return context;
}
