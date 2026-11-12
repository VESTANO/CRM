// A feed keeps one bounded incremental read in flight. Historical pages and
// socket events share the same ID store so a slow page cannot undo a new punch.
const epoch = "1970-01-01T00:00:00.000Z";
const timestampKey = (value = epoch) => `${new Date(value).toISOString().slice(0, 19)}.${(String(value).match(/\.(\d+)/)?.[1] || "").padEnd(6, "0").slice(0, 6)}`;
const overlap = (value) => new Date(Math.max(0, Date.parse(value || epoch) - 2000)).toISOString();

export function attendanceFeedErrorState(current, key, error, emptyData) {
  return { ...(current.key === key ? current : { data: emptyData }), key, loading: false, error: error?.message || "Unable to update attendance." };
}

export function createAttendanceFeed({ source, mapRecord, accepts, onSnapshot, onError, cached,
  pageSize = 500, isVisible = () => true, schedule = setInterval, cancel = clearInterval }) {
  let active = true;
  let metadata = cached?.metadata || null;
  let watermark = cached?.watermark || epoch;
  let complete = Boolean(cached?.complete);
  let boundaryDate = cached?.boundaryDate || "";
  let syncing = false;
  let metadataPending = false;
  let metadataDirty = false;
  let metadataTimer = null;
  let reconciling = false;
  let lastReconcile = 0;
  let booting = false;
  let baselineRead = Boolean(cached);
  let historyCursor = null;
  let retryAt = 0;
  let metadataRevision = 0;
  let recovering = false;
  let unsubscribe = () => {};
  const abort = new AbortController();
  const records = new Map((cached?.rows || []).map(row => [row.id, row]));
  const deleted = new Set();
  const removedVersions = new Map();
  let settleReady;
  const ready = new Promise(resolve => { settleReady = resolve; });

  function merge(rows, historical = false) {
    let changed = false;
    for (const row of rows) {
      if (deleted.has(row.id)) continue;
      const removedAt = removedVersions.get(row.id);
      if (removedAt && timestampKey(row.updated_at || row.created_at).localeCompare(removedAt) <= 0) continue;
      const prior = records.get(row.id);
      if (prior) {
        const comparison = timestampKey(row.updated_at || row.created_at).localeCompare(timestampKey(prior.updated_at || prior.created_at));
        if (comparison < 0 || (historical && comparison === 0)) continue;
      }
      if (!accepts(row)) {
        changed = records.delete(row.id) || changed;
      } else if (!prior || JSON.stringify(prior) !== JSON.stringify(row)) {
        records.set(row.id, row); removedVersions.delete(row.id); changed = true;
      }
    }
    return changed;
  }

  function snapshot() {
    if (!metadata) return null;
    const rows = [...records.values()].sort((a, b) => Date.parse(b.punched_at) - Date.parse(a.punched_at) || b.id.localeCompare(a.id));
    const normalized = rows.map(mapRecord).filter(row => complete || row.timestamp.slice(0, 10) !== boundaryDate);
    const dates = normalized.map(row => row.timestamp.slice(0, 10));
    const names = new Map(metadata.employees.map(employee => [employee.id, employee.name]));
    const mapping = new Map(metadata.mappings.map(item => [String(item.punch_code), item.user_id]));
    return {
      records: normalized, employees: metadata.employees, devices: metadata.devices,
      punchCodes: [...new Set(normalized.map(row => String(row.punchCode)))].map(punchCode => ({
        punchCode, userId: mapping.get(punchCode) || "", employeeName: names.get(mapping.get(punchCode)) || "",
      })),
      availableFrom: dates.at(-1) || "", availableTo: dates[0] || "",
      lastSync: metadata.devices[0]?.last_seen || null, historyLoading: !complete,
      source: "Live VestaTrack Supabase attendance", deviceConfig: {},
    };
  }
  function publish() { if (active && isVisible()) { const next = snapshot(); if (next) { recovering = false; onSnapshot(next); } } }
  function report(error) { if (active && error?.name !== "AbortError") { recovering = true; onError(error); } }
  async function refreshMetadata() {
    if (!active || metadataPending) return;
    metadataPending = true; metadataDirty = false;
    try { metadata = await source.metadata(abort.signal, true); metadataRevision += 1; publish(); }
    catch (error) { report(error); }
    finally { metadataPending = false; if (metadataDirty) queueMetadata(); }
  }
  function queueMetadata() {
    metadataDirty = true;
    if (!active || metadataTimer || metadataPending) return;
    metadataTimer = setTimeout(() => { metadataTimer = null; void refreshMetadata(); }, 300);
  }
  async function reconcile() {
    if (!active || !complete || reconciling || !source.ids || !isVisible()) return;
    reconciling = true; lastReconcile = Date.now();
    const before = new Map(records);
    try {
      const visible = new Set();
      let cursor = null;
      do {
        const rows = await source.ids({ cursor, limit: 1000, signal: abort.signal });
        if (!active) return;
        for (const row of rows) visible.add(row.id);
        cursor = rows.length === 1000 ? rows.at(-1).id : null;
      } while (cursor);
      let changed = false;
      for (const [id, row] of before) if (!visible.has(id) && records.get(id) === row) {
        removedVersions.set(id, timestampKey(row.updated_at || row.created_at));
        changed = records.delete(id) || changed;
      }
      if (changed || recovering) publish();
    } catch (error) { report(error); }
    finally { reconciling = false; }
  }
  async function sync() {
    if (!active || syncing || !metadata || !isVisible()) return;
    syncing = true;
    try {
      const since = overlap(watermark);
      let cursor = null;
      let changed = false;
      do {
        const rows = await source.changes({ since, cursor, limit: pageSize, signal: abort.signal });
        if (!active) return;
        changed = merge(rows) || changed;
        for (const row of rows) if (timestampKey(row.updated_at).localeCompare(timestampKey(watermark)) > 0) watermark = row.updated_at;
        cursor = rows.length === pageSize ? rows.at(-1) : null;
      } while (cursor && active);
      if (changed || recovering) publish();
    } catch (error) { report(error); }
    finally { syncing = false; }
  }
  async function bootstrap() {
    if (!active || booting || Date.now() < retryAt) return;
    booting = true;
    try {
      if (cached) publish();
      // A server timestamp is captured before snapshot reads. Client/device
      // clock skew cannot move the catch-up cursor past an unseen punch.
      if (!baselineRead) {
        const baseline = await source.version(abort.signal);
        if (!active) return;
        watermark = baseline || epoch; baselineRead = true;
      }
      const metadataRead = metadata ? Promise.resolve(metadata) : source.metadata(abort.signal);
      const metadataReadRevision = metadataRevision;
      // Handle a possible metadata failure even if a page request also fails.
      metadataRead.catch(() => {});
      if (complete) { publish(); settleReady(snapshot()); await sync(); void refreshMetadata(); void reconcile(); return; }
      let cursor = historyCursor;
      do {
        const [rows, nextMetadata] = await Promise.all([source.page({ cursor, limit: pageSize, signal: abort.signal }), metadataRead]);
        if (!active) return;
        if (metadataRevision === metadataReadRevision || !metadata) metadata = nextMetadata;
        merge(rows, true);
        complete = rows.length < pageSize;
        boundaryDate = complete ? "" : mapRecord(rows.at(-1)).timestamp.slice(0, 10);
        publish();
        cursor = complete ? null : rows.at(-1);
        historyCursor = cursor;
      } while (cursor && active);
      if (active) { settleReady(snapshot()); await sync(); void reconcile(); }
    } catch (error) { report(error); retryAt = Date.now() + 5000; settleReady(null); }
    finally { booting = false; }
  }
  unsubscribe = source.subscribe({
    onRecord: event => {
      if (!active) return;
      if (event.eventType === "DELETE") {
        const id = event.old?.id;
        if (id) { deleted.add(id); if (records.delete(id)) publish(); }
      } else if (event.new?.id && merge([event.new])) publish();
    },
    onMetadata: event => {
      if (!active) return;
      if (event?.table === "attendance_devices" && metadata) {
        const serial = event.new?.serial_number || event.old?.serial_number;
        const devices = metadata.devices.filter(device => device.serial_number !== serial);
        if (event.eventType !== "DELETE" && event.new?.serial_number) {
          const { serial_number, model, last_seen } = event.new;
          devices.push({ serial_number, model, last_seen });
        }
        metadata = { ...metadata, devices: devices.sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen)) };
        metadataRevision += 1;
        publish();
      } else queueMetadata();
    },
    onConnected: () => { void sync(); void reconcile(); },
  });
  const timer = schedule(() => { if (!complete && isVisible()) void bootstrap(); void sync(); if (Date.now() - lastReconcile >= 30_000) void reconcile(); }, 1000);
  void bootstrap();
  return {
    ready,
    wake() { publish(); if (!complete) { retryAt = 0; void bootstrap(); } void sync(); void reconcile(); },
    stop() {
      active = false; abort.abort(); cancel(timer); if (metadataTimer) clearTimeout(metadataTimer); unsubscribe(); settleReady(null);
      return { rows: [...records.values()], metadata, watermark, boundaryDate, complete };
    },
  };
}
