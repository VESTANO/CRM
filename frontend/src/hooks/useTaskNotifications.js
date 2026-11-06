import { useMemo, useSyncExternalStore } from "react";
import { useAuth } from "./useAuth.jsx";
import { invalidateApiCache, taskNotificationsApi } from "../services/api.js";
import { crmSupabase } from "../services/crmSupabase.js";
import { createTaskNotificationFeed } from "../services/taskNotificationFeed.js";
import { useStoreContext } from "./useStoreContext.js";

const feeds = new Map();
const empty = { notifications: [], unreadCount: 0, alerts: [], loaded: false, error: "" };
const noop = () => {};
const emptySubscribe = () => noop;
const getEmpty = () => empty;
const emptyAction = () => Promise.resolve(false);

export function useTaskNotifications() {
  const { user } = useAuth();
  const storeId = useStoreContext();
  const feed = useMemo(() => {
    if (!user?.id || (user.is_superuser && !storeId)) return null;
    const key = `${user.id}|${Boolean(user.is_admin)}|${storeId}`;
    if (!feeds.has(key)) {
      const created = createTaskNotificationFeed({
        load: async () => (await taskNotificationsApi.list()).data,
        markRead: taskNotificationsApi.markRead,
        markAllRead: taskNotificationsApi.markAllRead,
        onTaskChange: () => {
          invalidateApiCache("/tasks/", "/admin/tasks/");
          window.dispatchEvent(new Event("crm:tasks-updated"));
        },
        connect: (changed, connected) => {
          const options = { schema: "public", table: "crm_task_notifications", filter: `recipient_id=eq.${user.id}` };
          const channel = crmSupabase.channel(`crm-task-notifications:${user.id}`)
            .on("postgres_changes", { ...options, event: "INSERT" }, changed)
            .on("postgres_changes", { ...options, event: "UPDATE" }, changed)
            .subscribe((status) => { if (status === "SUBSCRIBED") connected(); });
          return () => { void crmSupabase.removeChannel(channel).catch(() => {}); };
        },
        onIdle: () => { if (feeds.get(key) === created) feeds.delete(key); },
      });
      feeds.set(key, created);
    }
    return feeds.get(key);
  }, [user?.id, user?.is_admin, user?.is_superuser, storeId]);
  const snapshot = useSyncExternalStore(feed?.subscribe || emptySubscribe, feed?.getSnapshot || getEmpty, getEmpty);
  return { ...snapshot, refresh: feed?.refresh || emptyAction, markRead: feed?.markRead || emptyAction,
    markAllRead: feed?.markAllRead || emptyAction, dismissAlert: feed?.dismissAlert || noop };
}
