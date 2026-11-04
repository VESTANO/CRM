import { useEffect, useState } from "react";
import { nextTaskDeadlineDelay } from "../utils/tasks.js";

export function useTaskClock(tasks) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => { setNow(Date.now()); }, [tasks]);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const delay = nextTaskDeadlineDelay(tasks, Date.now());
    const timer = delay === null ? null : window.setTimeout(update, delay);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [tasks, now]);

  return now;
}
