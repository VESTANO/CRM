import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../services/api.js";
import { attendanceSupabase, getAttendanceSession, runAttendanceAuthTask } from "../services/attendanceSupabase.js";
import { useAuth } from "./useAuth.jsx";

const AttendanceAuthContext = createContext(null);
const emptyAccess = { session: null, profile: null, permission: null, owner: null };

export function AttendanceAuthProvider({ children }) {
  const { user } = useAuth();
  const [access, setAccess] = useState(emptyAccess);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const logout = useCallback(async () => {
    generation.current += 1;
    setAccess(emptyAccess); setError(""); setIsLoading(false);
    await runAttendanceAuthTask(() => attendanceSupabase.auth.signOut({ scope: "local" }));
  }, []);
  const restore = useCallback(async () => {
    const request = ++generation.current;
    setAccess(emptyAccess);
    setIsLoading(true); setError("");
    try {
      return await runAttendanceAuthTask(async () => {
        if (request !== generation.current) return false;
        await attendanceSupabase.auth.signOut({ scope: "local" });
        if (!user?.id || request !== generation.current) return false;
        const { data } = await apiClient.post("/auth/attendance-session/", {});
        if (request !== generation.current) return false;
        const { error: sessionError } = await attendanceSupabase.auth.setSession(data);
        if (sessionError) throw sessionError;
        try {
          const restored = await getAttendanceSession();
          if (!restored.profile || !restored.permission?.allowed) throw new Error(restored.permission?.message || "Attendance access is unavailable.");
          if (request !== generation.current) {
            await attendanceSupabase.auth.signOut({ scope: "local" });
            return false;
          }
          setAccess({ ...restored, owner: user.id });
          return true;
        } catch (error) {
          await attendanceSupabase.auth.signOut({ scope: "local" });
          throw error;
        }
      });
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
      if (event === "SIGNED_OUT") setAccess(emptyAccess);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  const value = useMemo(() => ({ ...(access.owner === user?.id ? access : emptyAccess), isLoading, error, restore, logout }), [access, user?.id, isLoading, error, restore, logout]);
  return <AttendanceAuthContext.Provider value={value}>{children}</AttendanceAuthContext.Provider>;
}

export function useAttendanceAuth() {
  const context = useContext(AttendanceAuthContext);
  if (!context) throw new Error("useAttendanceAuth must be used inside AttendanceAuthProvider");
  return context;
}
