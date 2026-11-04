import assert from "node:assert/strict";
import test from "node:test";
import { attendanceFeedErrorState, createAttendanceFeed } from "./attendanceFeed.js";

const metadata = { employees: [{ id: "user", name: "Employee" }], mappings: [], devices: [] };
const row = (id, date = "2026-11-04", version = "2026-11-04T08:00:00.000001Z") => ({
  id: String(id).padStart(8, "0"), user_id: "user", punched_at: `${date}T08:00:00Z`, updated_at: version, created_at: version,
});
const normalize = value => ({ id: value.id, userId: value.user_id, employeeName: value.employee_name, timestamp: value.punched_at.replace("T", " ").slice(0, 19) });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(rows = [], overrides = {}, options = {}) {
  let tick;
  let events;
  let stopped = false;
  const snapshots = [];
  const errors = [];
  const calls = { pages: 0, changes: 0 };
  const ordered = [...rows].sort((a, b) => b.punched_at.localeCompare(a.punched_at) || b.id.localeCompare(a.id));
  const source = {
    version: async () => rows.at(-1)?.updated_at,
    metadata: async () => metadata,
    page: async ({ cursor, limit }) => { calls.pages += 1; const start = cursor ? ordered.findIndex(value => value.id === cursor.id) + 1 : 0; return ordered.slice(start, start + limit); },
    changes: async () => { calls.changes += 1; return []; },
    subscribe: handlers => { events = handlers; return () => { stopped = true; }; },
    ...overrides,
  };
  const feed = createAttendanceFeed({ source, mapRecord: normalize, accepts: value => value.user_id === "user", onSnapshot: value => snapshots.push(value), onError: error => errors.push(error),
    schedule: callback => { tick = callback; return 1; }, cancel: () => {}, ...options });
  return { feed, snapshots, errors, calls, get events() { return events; }, tick: () => tick(), get stopped() { return stopped; } };
}

test("loads every history page beyond the server cap and never publishes a partial day", async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => row(index, `2026-10-${String(1 + Math.floor(index / 50)).padStart(2, "0")}`));
  const f = fixture(rows);
  const result = await f.feed.ready;
  assert.equal(result.records.length, 1205);
  assert.equal(f.calls.pages, 3);
  assert.ok(f.snapshots.some(value => value.historyLoading && value.records.length > 0));
  for (const value of f.snapshots) {
    for (const date of new Set(value.records.map(record => record.timestamp.slice(0, 10)))) {
      assert.equal(value.records.filter(record => record.timestamp.startsWith(date)).length, rows.filter(record => record.punched_at.startsWith(date)).length);
    }
  }
  f.feed.stop();
});

test("a late historical page cannot overwrite a newer socket update or new punch", async () => {
  const pending = deferred();
  let pages = 0;
  const original = row(1);
  const newer = { ...original, employee_name: "Updated", updated_at: "2026-11-04T08:00:01.123456Z" };
  const added = row(2, "2026-11-04", "2026-11-04T08:00:02.123456Z");
  const f = fixture([], { page: async () => ++pages === 1 ? pending.promise : [] }, { pageSize: 1 });
  await flush();
  f.events.onRecord({ eventType: "UPDATE", new: newer });
  f.events.onRecord({ eventType: "INSERT", new: added });
  pending.resolve([original]);
  const result = await f.feed.ready;
  assert.equal(result.records.length, 2);
  assert.equal(result.records.find(value => value.id === original.id).employeeName, "Updated");
  f.feed.stop();
});

test("DELETE wins over an incremental response already in flight", async () => {
  const pending = deferred();
  const original = row(1);
  const f = fixture([], { changes: async () => pending.promise }, { cached: { rows: [original], metadata, watermark: original.updated_at, complete: true } });
  await flush();
  f.events.onRecord({ eventType: "DELETE", old: { id: original.id } });
  pending.resolve([original]);
  await flush();
  assert.equal(f.snapshots.at(-1).records.length, 0);
  f.feed.stop();
});

test("one-second catch-up is incremental, does not overlap, and pauses when hidden", async () => {
  const pending = deferred();
  const original = row(1);
  let visible = true;
  let calls = 0;
  let request;
  const f = fixture([], { changes: async args => { calls += 1; request = args; return pending.promise; } }, {
    isVisible: () => visible, cached: { rows: [original], metadata, watermark: original.updated_at, complete: true },
  });
  await flush();
  f.tick(); f.tick(); f.tick();
  assert.equal(calls, 1);
  assert.equal(request.since, "2026-11-04T07:59:58.000Z");
  assert.equal(f.calls.pages, 0);
  pending.resolve([]); await flush();
  visible = false; f.tick(); await flush();
  assert.equal(calls, 1);
  visible = true; f.feed.wake(); await flush();
  assert.equal(calls, 2);
  const count = f.snapshots.length;
  f.feed.stop(); f.events.onRecord({ eventType: "INSERT", new: row(2) }); f.tick();
  assert.equal(f.snapshots.length, count);
  assert.equal(f.stopped, true);
});

test("server cursor drains same-timestamp incremental batches and applies filter removals", async () => {
  const rows = [row(1), row(2), { ...row(3), user_id: "other" }];
  const cursors = [];
  const f = fixture([], {
    changes: async ({ cursor, limit }) => { cursors.push(cursor?.id || null); return rows.filter(value => !cursor || value.id > cursor.id).slice(0, limit); },
  }, { pageSize: 2, cached: { rows: [row(3)], metadata, watermark: rows[0].updated_at, complete: true } });
  await flush(); await flush();
  assert.deepEqual(cursors, [null, rows[1].id]);
  assert.deepEqual(f.snapshots.at(-1).records.map(value => value.id).sort(), rows.slice(0, 2).map(value => value.id));
  f.feed.stop();
});

test("opening offline recovers history on wake without reloading the page", async () => {
  let failed = true;
  const f = fixture([row(1)], { metadata: async () => { if (failed) throw new Error("offline"); return metadata; } });
  await flush();
  assert.equal(f.errors[0].message, "offline");
  failed = false; f.feed.wake(); await flush(); await flush();
  assert.equal(f.snapshots.at(-1).records.length, 1);
  assert.equal(f.snapshots.at(-1).historyLoading, false);
  f.feed.stop();
});

test("an error for a different identity/filter cannot re-tag the previous records", () => {
  const previous = { key: "admin", data: { records: [row(1)] }, loading: false };
  const empty = { records: [] };
  const result = attendanceFeedErrorState(previous, "employee", new Error("denied"), empty);
  assert.equal(result.data, empty);
  assert.equal(result.key, "employee");
  assert.equal(attendanceFeedErrorState(previous, "admin", new Error("offline"), empty).data, previous.data);
});

test("a successful empty catch-up clears a transient error without repainting every second", async () => {
  let attempts = 0;
  const f = fixture([row(1)], { changes: async () => { if (++attempts === 1) throw new Error("temporary failure"); return []; } });
  await f.feed.ready; await flush();
  assert.equal(f.errors.length, 1);
  const before = f.snapshots.length;
  f.tick(); await flush();
  assert.equal(f.snapshots.length, before + 1);
  f.tick(); await flush();
  assert.equal(f.snapshots.length, before + 1);
  f.feed.stop();
});
