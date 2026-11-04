export function createTaskFeed({
  load, initialTasks = null, intervalMs = 5000,
  events = globalThis.window, visibility = globalThis.document,
  timers = globalThis, onIdle = () => {},
}) {
  let snapshot = { tasks: initialTasks, error: "" };
  let signature = JSON.stringify(initialTasks);
  const listeners = new Set();
  let timer, request = null, generation = 0, refreshQueued = false;

  const publish = (tasks, error = "") => {
    const nextSignature = JSON.stringify(tasks);
    if (nextSignature === signature && error === snapshot.error) return;
    signature = nextSignature;
    snapshot = { tasks, error };
    for (const listener of listeners) listener();
  };

  const refresh = ({ force = false } = {}) => {
    if (!listeners.size || visibility?.hidden) return Promise.resolve();
    if (request) {
      if (force) refreshQueued = true;
      return request;
    }
    const started = generation;
    const pending = Promise.resolve().then(load).then((tasks) => {
      if (started === generation && listeners.size) publish(tasks);
    }, (error) => {
      if (started !== generation || !listeners.size) return;
      const denied = [401, 403].includes(error.response?.status);
      publish(denied ? null : snapshot.tasks, error.response?.data?.detail || "Unable to load assigned tasks.");
    }).finally(() => {
      if (request !== pending) return;
      request = null;
      if (refreshQueued && listeners.size) {
        refreshQueued = false;
        return refresh();
      }
    });
    request = pending;
    return pending;
  };

  const poll = () => { void refresh(); };
  const changed = () => { void refresh({ force: true }); };
  const stop = () => {
    generation++;
    request = null;
    refreshQueued = false;
    timers.clearInterval(timer);
    events?.removeEventListener("focus", poll);
    events?.removeEventListener("online", poll);
    events?.removeEventListener("crm:tasks-updated", changed);
    visibility?.removeEventListener("visibilitychange", poll);
    queueMicrotask(() => { if (!listeners.size) onIdle(); });
  };

  return {
    getSnapshot: () => snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        timer = timers.setInterval(poll, intervalMs);
        events?.addEventListener("focus", poll);
        events?.addEventListener("online", poll);
        events?.addEventListener("crm:tasks-updated", changed);
        visibility?.addEventListener("visibilitychange", poll);
        poll();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
  };
}
