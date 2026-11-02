import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../services/api.js";
import { attendanceSupabase, getAttendanceSession, runAttendanceAuthTask } from "../services/attendanceSupabase.js";
import { useAuth } from "./useAuth.jsx";

const AttendanceAuthContext = createContext(null);

export function AttendanceAuthProvider({ children }) {
  const { user } = useAuth();
  const [access, setAccess] = useState({ session: null, profile: null, permission: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const restore = useCallback(async () => {
    const request = ++generation.current;
    setAccess({ session: null, profile: null, permission: null });
    setIsLoading(true); setError("");
    try {
      if (!user?.id) return;
      await runAttendanceAuthTask(async () => {
        if (request !== generation.current) return;
        await attendanceSupabase.auth.signOut({ scope: "local" });
        const { data } = await apiClient.post("/auth/attendance-session/", {});
        if (request !== generation.current) return;
        const { error: sessionError } = await attendanceSupabase.auth.setSession(data);
        if (sessionError) throw sessionError;
        const restored = await getAttendanceSession();
        if (request === generation.current) setAccess(restored);
        else await attendanceSupabase.auth.signOut({ scope: "local" });
      });
    } catch (restoreError) {
      if (request === generation.current) setError(restoreError.response?.data?.detail || restoreError.message || "Unable to open attendance.");
    } finally {
      if (request === generation.current) setIsLoading(false);
    }
  }, [user?.id]);
  useEffect(() => {
    restore();
    return () => { generation.current += 1; };
  }, [restore]);
  const value = useMemo(() => ({ ...access, isLoading, error, restore }), [access, isLoading, error, restore]);
  return <AttendanceAuthContext.Provider value={value}>{children}</AttendanceAuthContext.Provider>;
}

export function useAttendanceAuth() {
  const context = useContext(AttendanceAuthContext);
  if (!context) throw new Error("useAttendanceAuth must be used inside AttendanceAuthProvider");
  return context;
}
