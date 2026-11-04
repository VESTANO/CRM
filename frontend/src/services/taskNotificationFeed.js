export function createTaskNotificationFeed({
  load, markRead, markAllRead, connect = () => () => {}, onTaskChange = () => {}, onIdle = () => {},
  initialData = null, events = globalThis.window, visibility = globalThis.document, timers = globalThis,
}) {
  let snapshot = {
    notifications: initialData?.results || [], unreadCount: initialData?.unread_count || 0,
    alerts: [], loaded: Boolean(initialData), error: "",
  };
  let baseline = Boolean(initialData), baselineMax = Math.max(0, ...snapshot.notifications.map((row) => row.id));
  const seen = new Set(snapshot.notifications.map((row) => String(row.id)));
  const incoming = new Set();
  const listeners = new Set();
  let request = null, queued = false, generation = 0, interval, disconnect;
  const publish = (changes) => {
    const next = { ...snapshot, ...changes };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const apply = (data) => {
    const rows = data.results || [];
    const newRows = rows.filter((row) => !seen.has(String(row.id)) &&
      (incoming.has(String(row.id)) || (baseline && Number(row.id) > baselineMax)));
    const unread = newRows.filter((row) => !row.read_at);
    const readIds = new Set(rows.filter((row) => row.read_at).map((row) => String(row.id)));
    const alerts = [...snapshot.alerts.filter((row) => !readIds.has(String(row.id))), ...unread.slice().reverse()].slice(-3);
    const polledTaskChange = newRows.some((row) => !incoming.has(String(row.id)));
    if (!baseline) baselineMax = Math.max(0, ...rows.map((row) => Number(row.id)));
    baseline = true;
    for (const row of rows) { seen.add(String(row.id)); incoming.delete(String(row.id)); }
    while (seen.size > 3000) seen.delete(seen.values().next().value);
    publish({ notifications: rows, unreadCount: data.unread_count || 0, alerts, loaded: true, error: "" });
    if (polledTaskChange) onTaskChange();
  };
  const refresh = ({ force = false } = {}) => {
    if (!listeners.size || (visibility?.hidden && !force)) return Promise.resolve();
    if (request) { if (force) queued = true; return request; }
    const started = generation;
    const pending = Promise.resolve().then(load).then((data) => {
      if (started === generation && listeners.size) apply(data);
    }, (error) => {
      if (started !== generation || !listeners.size) return;
      if ([401, 403].includes(error.response?.status)) {
        baseline = false; seen.clear(); incoming.clear();
        publish({ notifications: [], unreadCount: 0, alerts: [], loaded: false, error: "" });
      } else publish({ error: error.response?.data?.detail || "Unable to load task notifications." });
    }).finally(() => {
      if (request !== pending) return;
      request = null;
      if (queued && listeners.size) { queued = false; return refresh({ force: true }); }
    });
    request = pending;
    return pending;
  };
  const changed = (payload) => {
    if (!listeners.size) return;
    if (payload.eventType === "INSERT" && payload.new?.id) {
      if (seen.has(String(payload.new.id)) || incoming.has(String(payload.new.id))) return;
      incoming.add(String(payload.new.id));
      while (incoming.size > 3000) incoming.delete(incoming.values().next().value);
      onTaskChange();
    }
    void refresh({ force: true });
  };
  const poll = () => { void refresh(); };
  const connected = () => { void refresh({ force: true }); };
  const dismissAlert = (id) => publish({ alerts: snapshot.alerts.filter((row) => String(row.id) !== String(id)) });
  const mutate = async (operation, onSuccess) => {
    const started = generation;
    try {
      await operation();
      if (started !== generation || !listeners.size) return false;
      onSuccess?.();
      await refresh({ force: true });
      return true;
    } catch (error) {
      if (started === generation && listeners.size) publish({ error: error.response?.data?.detail || "Unable to mark notifications as read." });
      return false;
    }
  };
  return {
    getSnapshot: () => snapshot, refresh, dismissAlert,
    markRead: (id) => mutate(() => markRead(id), () => dismissAlert(id)),
    markAllRead: () => {
      const throughId = snapshot.notifications[0]?.id;
      if (!throughId) return Promise.resolve(true);
      return mutate(() => markAllRead(throughId));
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        interval = timers.setInterval(poll, 5000);
        events?.addEventListener("focus", poll);
        events?.addEventListener("online", connected);
        visibility?.addEventListener("visibilitychange", poll);
        try { disconnect = connect(changed, connected); } catch { disconnect = null; }
        poll();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        generation++; request = null; queued = false;
        timers.clearInterval(interval);
        disconnect?.(); disconnect = null;
        events?.removeEventListener("focus", poll);
        events?.removeEventListener("online", connected);
        visibility?.removeEventListener("visibilitychange", poll);
        queueMicrotask(() => { if (!listeners.size) onIdle(); });
      };
    },
  };
}
