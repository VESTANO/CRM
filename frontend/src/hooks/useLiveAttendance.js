import { useEffect, useState } from "react";
import { watchLiveAttendance } from "../services/attendanceSupabase.js";
import { attendanceFeedErrorState } from "../services/attendanceFeed.js";
import { useStoreContext } from "./useStoreContext.js";

const emptyData = { records: [], employees: [], punchCodes: [], devices: [], availableFrom: "", availableTo: "", historyLoading: true };

export function useLiveAttendance({ profile, filters, enabled, refreshKey }) {
  const storeId = useStoreContext();
  const key = JSON.stringify([storeId, profile?.storeId, profile?.id, profile?.role, profile?.active, profile?.name, profile?.employeeId, profile?.shiftStartTime, profile?.shiftEndTime, filters.from, filters.to, filters.userId, refreshKey]);
  const [state, setState] = useState({ key: "", data: emptyData, loading: true, error: "" });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const feed = watchLiveAttendance({
      ...filters, profile, isVisible: () => !document.hidden,
      onSnapshot: data => { if (active) setState({ key, data, loading: false, error: "" }); },
      onError: error => { if (active) setState(current => attendanceFeedErrorState(current, key, error, emptyData)); },
    });
    const wake = () => { if (!document.hidden) { setNow(new Date()); feed.wake(); } };
    const timer = window.setInterval(() => { if (!document.hidden) setNow(new Date()); }, 1000);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => { active = false; feed.stop(); window.clearInterval(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [enabled, key]);
  const current = state.key === key ? state : { data: emptyData, loading: true, error: "" };
  return { ...current, now, refreshing: false };
}
