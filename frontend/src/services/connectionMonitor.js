// One health probe at a time, only while this workspace is visible. The owner
// disposes the monitor so late network completions cannot update an old view.
export function createConnectionMonitor({ probe, onStatus, host = window, document: doc = document, network = navigator, intervalMs = 5_000, timeoutMs = 4_000 }) {
  let disposed = false;
  let interval;
  let active;
  let generation = 0;

  const cancelProbe = () => {
    generation += 1;
    if (!active) return;
    host.clearTimeout(active.timeout);
    active.controller.abort();
    active = null;
  };
  const check = () => {
    if (disposed || doc.hidden) return Promise.resolve(null);
    if (!network.onLine) {
      cancelProbe();
      onStatus(false);
      return Promise.resolve(false);
    }
    if (active) return active.request;
    const controller = new AbortController();
    const current = ++generation;
    const timeout = host.setTimeout(() => controller.abort(), timeoutMs);
    const request = Promise.resolve().then(() => {
      if (disposed || generation !== current) return false;
      return probe(controller.signal);
    }).then((connected) => {
      if (!disposed && generation === current) onStatus(Boolean(connected));
      return Boolean(connected);
    }, () => {
      if (!disposed && generation === current) onStatus(false);
      return false;
    }).finally(() => {
      host.clearTimeout(timeout);
      if (active?.request === request) active = null;
    });
    active = { controller, request, timeout };
    return request;
  };
  const pause = () => { host.clearInterval(interval); interval = undefined; cancelProbe(); };
  const resume = () => {
    if (disposed || doc.hidden) return;
    if (interval === undefined) interval = host.setInterval(check, intervalMs);
    check();
  };
  const offline = () => { cancelProbe(); onStatus(false); };
  const visibility = () => { if (doc.hidden) pause(); else resume(); };
  host.addEventListener("online", check);
  host.addEventListener("offline", offline);
  host.addEventListener("focus", check);
  doc.addEventListener("visibilitychange", visibility);
  resume();
  return {
    check,
    dispose() {
      disposed = true;
      pause();
      host.removeEventListener("online", check);
      host.removeEventListener("offline", offline);
      host.removeEventListener("focus", check);
      doc.removeEventListener("visibilitychange", visibility);
    },
  };
}
