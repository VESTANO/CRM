import assert from "node:assert/strict";
import test from "node:test";
import { createTaskNotificationFeed } from "./taskNotificationFeed.js";

const flush = () => new Promise(setImmediate);
const row = (id, kind = "approved", read_at = null) => ({ id, kind, task_id: 7, title: `Task ${kind}`, message: "Arrange the shelf", read_at });
function setup(extra = {}) {
  let rows = [], notify, connected, loads = 0, connects = 0, disconnects = 0, taskChanges = 0;
  const intervals = new Map();
  const events = new EventTarget(), visibility = new EventTarget(); visibility.hidden = false;
  const timers = { setInterval: (callback, ms) => { assert.equal(ms, 5000); intervals.set(1, callback); return 1; }, clearInterval: (id) => intervals.delete(id) };
  const feed = createTaskNotificationFeed({
    load: async () => { loads++; return { results: structuredClone(rows), unread_count: rows.filter((item) => !item.read_at).length }; },
    markRead: async (id) => { rows = rows.map((item) => item.id === id ? { ...item, read_at: "now" } : item); },
    markAllRead: async (through) => { rows = rows.map((item) => item.id <= through ? { ...item, read_at: "now" } : item); },
    connect: (change, ready) => { connects++; notify = change; connected = ready; return () => { disconnects++; }; },
    onTaskChange: () => taskChanges++, events, visibility, timers, ...extra,
  });
  return { feed, events, visibility, intervals, setRows: (next) => { rows = next; }, emit: (item, eventType = "INSERT") => notify({ eventType, new: item }),
    reconnect: () => connected(), tick: () => [...intervals.values()].forEach((callback) => callback()),
    stats: () => ({ loads, connects, disconnects, taskChanges }) };
}

test("badge, inbox and alerts share one live subscription and one fallback poll", async () => {
  const env = setup(); let updates = 0;
  const stops = [1, 2, 3].map(() => env.feed.subscribe(() => updates++));
  await flush();
  assert.equal(env.stats().connects, 1); assert.equal(env.intervals.size, 1);
  env.setRows([row(1)]); env.emit(row(1)); await flush();
  assert.equal(env.feed.getSnapshot().unreadCount, 1);
  assert.equal(env.feed.getSnapshot().alerts[0].kind, "approved");
  assert.equal(env.stats().taskChanges, 1);
  const after = updates;
  env.emit(row(1)); env.tick(); await flush();
  assert.equal(updates, after, "duplicates and unchanged polls do not create alerts or rerenders");
  stops.forEach((stop) => stop());
  assert.equal(env.stats().disconnects, 1); assert.equal(env.intervals.size, 0);
});

test("existing notifications seed unread counts without replaying old alerts", async () => {
  const env = setup(); env.setRows([row(5), row(4, "rejected")]);
  const stop = env.feed.subscribe(() => {}); await flush();
  assert.equal(env.feed.getSnapshot().unreadCount, 2); assert.deepEqual(env.feed.getSnapshot().alerts, []);
  env.setRows([row(6, "resubmitted"), row(5), row(4, "rejected")]); env.tick(); await flush();
  assert.deepEqual(env.feed.getSnapshot().alerts.map((item) => item.id), [6]);
  assert.equal(env.stats().taskChanges, 1, "fallback polling refreshes task status too");
  stop();
});

test("a notification arriving during initial loading is not lost", async () => {
  let release, calls = 0;
  const env = setup({ load: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ results: [row(1)], unread_count: 1 }) });
  const stop = env.feed.subscribe(() => {}); await Promise.resolve();
  env.emit(row(1)); env.reconnect();
  release({ results: [], unread_count: 0 }); await flush();
  assert.equal(calls, 2); assert.equal(env.feed.getSnapshot().alerts[0].id, 1);
  stop();
});

test("live alerts update a background account and polling resumes on visibility/reconnect", async () => {
  const env = setup(); const stop = env.feed.subscribe(() => {}); await flush();
  env.visibility.hidden = true; env.tick(); await flush(); assert.equal(env.stats().loads, 1);
  env.setRows([row(1, "rejected")]); env.emit(row(1, "rejected")); await flush();
  assert.equal(env.feed.getSnapshot().alerts[0].kind, "rejected");
  env.visibility.hidden = false; env.visibility.dispatchEvent(new Event("visibilitychange")); await flush();
  env.setRows([row(2, "approved"), row(1, "rejected")]); env.reconnect(); await flush();
  assert.equal(env.feed.getSnapshot().unreadCount, 2);
  stop();
});

test("read state synchronizes across accounts' tabs without creating another toast", async () => {
  const env = setup(); const stop = env.feed.subscribe(() => {}); await flush();
  env.setRows([row(1)]); env.emit(row(1)); await flush();
  env.setRows([row(1, "approved", "now")]); env.emit(row(1, "approved", "now"), "UPDATE"); await flush();
  assert.equal(env.feed.getSnapshot().unreadCount, 0); assert.deepEqual(env.feed.getSnapshot().alerts, []);
  assert.equal(env.stats().taskChanges, 1);
  stop();
});

test("marking all read preserves arrivals during the request, including out-of-order commits", async () => {
  for (const incomingId of [1, 3]) {
    let release;
    const env = setup({ markAllRead: (through) => { assert.equal(through, 2); return new Promise((resolve) => { release = resolve; }); } });
    env.setRows([row(2)]); const stop = env.feed.subscribe(() => {}); await flush();
    const marking = env.feed.markAllRead();
    env.setRows([row(incomingId), row(2, "approved", "now")].sort((a, b) => b.id - a.id)); env.emit(row(incomingId)); await flush();
    release(); await marking;
    assert.equal(env.feed.getSnapshot().unreadCount, 1);
    assert.deepEqual(env.feed.getSnapshot().alerts.map((item) => item.id), [incomingId]);
    stop();
  }
});

test("failed loads preserve notifications, access denial clears them, and logout ignores old responses", async () => {
  let mode = "success", release;
  const env = setup({ load: () => {
    if (mode === "offline") return Promise.reject(new Error("offline"));
    if (mode === "denied") return Promise.reject({ response: { status: 403 } });
    if (mode === "slow") return new Promise((resolve) => { release = resolve; });
    return Promise.resolve({ results: [row(1)], unread_count: 1 });
  } });
  const stop = env.feed.subscribe(() => {}); await flush();
  mode = "offline"; env.tick(); await flush(); assert.equal(env.feed.getSnapshot().unreadCount, 1);
  mode = "denied"; env.tick(); await flush(); assert.deepEqual(env.feed.getSnapshot().notifications, []);
  mode = "slow"; env.tick(); await Promise.resolve(); stop();
  release({ results: [row(2)], unread_count: 1 }); await flush();
  assert.deepEqual(env.feed.getSnapshot().notifications, []); assert.equal(env.stats().disconnects, 1);
});

test("mark read removes the alert and connection failures retain polling", async () => {
  const env = setup({ connect: () => { throw new Error("WebSocket unavailable"); } });
  const stop = env.feed.subscribe(() => {}); await flush();
  env.setRows([row(1)]); env.tick(); await flush();
  assert.equal(env.feed.getSnapshot().alerts.length, 1);
  await env.feed.markRead(1);
  assert.equal(env.feed.getSnapshot().unreadCount, 0); assert.equal(env.feed.getSnapshot().alerts.length, 0);
  stop();
});
