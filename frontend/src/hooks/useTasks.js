import { useMemo, useSyncExternalStore } from "react";
import { useAuth } from "./useAuth.jsx";
import { adminApi, peekCachedResponse, tasksApi } from "../services/api.js";
import { createTaskFeed } from "../services/taskFeed.js";

const feeds = new Map();
const emptySnapshot = { tasks: null, error: "" };
const emptySubscribe = () => () => {};
const getEmptySnapshot = () => emptySnapshot;
const emptyRefresh = () => Promise.resolve();

export function useTasks({ all = false } = {}) {
  const { user } = useAuth();
  const userId = user?.id;
  const isAdmin = Boolean(user?.is_admin);
  const allTasks = all && isAdmin;
  const feed = useMemo(() => {
    if (!userId) return null;
    const key = `${userId}|${isAdmin}|${allTasks}`;
    if (!feeds.has(key)) {
      const created = createTaskFeed({
        initialTasks: peekCachedResponse(allTasks ? "/admin/tasks/" : "/tasks/")?.data?.results ?? null,
        load: async () => {
          const { data } = await (allTasks ? adminApi.tasks({}, { fresh: true }) : tasksApi.list({ fresh: true }));
          return data.results;
        },
        onIdle: () => { if (feeds.get(key) === created) feeds.delete(key); },
      });
      feeds.set(key, created);
    }
    return feeds.get(key);
  }, [userId, isAdmin, allTasks]);

  const snapshot = useSyncExternalStore(feed?.subscribe || emptySubscribe, feed?.getSnapshot || getEmptySnapshot, getEmptySnapshot);
  return { ...snapshot, refresh: feed?.refresh || emptyRefresh };
}
