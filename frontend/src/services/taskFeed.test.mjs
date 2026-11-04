import assert from "node:assert/strict";
import test from "node:test";
import { createTaskFeed } from "./taskFeed.js";

const flush = () => new Promise(setImmediate);
function environment(load, extra = {}) {
  const events = new EventTarget();
  const visibility = new EventTarget();
  visibility.hidden = false;
  const intervals = new Map();
  let nextId = 0;
  const timers = {
    setInterval(callback, ms) { assert.equal(ms, 5000); intervals.set(++nextId, callback); return nextId; },
    clearInterval(id) { intervals.delete(id); },
  };
  const feed = createTaskFeed({ load, events, visibility, timers, ...extra });
  return { feed, events, visibility, intervals, tick: () => [...intervals.values()].forEach((callback) => callback()) };
}

test("sidebar and task page share one poll and both receive remote assignments", async () => {
  let rows = [], calls = 0, badgeUpdates = 0, pageUpdates = 0;
  const env = environment(async () => { calls++; return structuredClone(rows); });
  const stopBadge = env.feed.subscribe(() => badgeUpdates++);
  const stopPage = env.feed.subscribe(() => pageUpdates++);
  await flush();
  assert.equal(calls, 1);
  assert.equal(env.intervals.size, 1);
  rows = [{ id: 1, title: "New assignment", status: "pending" }];
  env.tick(); await flush();
  assert.equal(calls, 2);
  assert.equal(env.feed.getSnapshot().tasks[0].title, "New assignment");
  assert.equal(badgeUpdates, 2);
  assert.equal(pageUpdates, 2);
  env.tick(); await flush();
  assert.equal(badgeUpdates, 2, "unchanged tasks must not rerender the sidebar");
  stopBadge(); stopPage();
  assert.equal(env.intervals.size, 0);
});

test("hidden accounts pause polling and update immediately when visible again", async () => {
  let calls = 0;
  const env = environment(async () => [{ id: ++calls }]);
  const stop = env.feed.subscribe(() => {}); await flush();
  env.visibility.hidden = true;
  env.tick(); await flush();
  assert.equal(calls, 1);
  env.visibility.hidden = false;
  env.visibility.dispatchEvent(new Event("visibilitychange")); await flush();
  assert.equal(calls, 2);
  env.events.dispatchEvent(new Event("focus")); await flush();
  assert.equal(calls, 3);
  stop();
});

test("requests do not overlap and a mutation during a read triggers a fresh follow-up", async () => {
  let calls = 0, release;
  const env = environment(() => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve([{ id: 2, status: "pending" }]);
  });
  const stop = env.feed.subscribe(() => {}); await Promise.resolve();
  env.tick(); env.tick();
  const pending = env.feed.refresh();
  assert.equal(calls, 1);
  env.events.dispatchEvent(new Event("crm:tasks-updated"));
  release([]); await pending;
  assert.equal(calls, 2);
  assert.equal(env.feed.getSnapshot().tasks[0].id, 2);
  stop();
});

test("task completion and reconnection refresh without waiting for the timer", async () => {
  let rows = [{ id: 1, status: "pending" }], calls = 0;
  const env = environment(async () => { calls++; return structuredClone(rows); });
  const stop = env.feed.subscribe(() => {}); await flush();
  rows[0].status = "done";
  env.events.dispatchEvent(new Event("crm:tasks-updated")); await flush();
  assert.equal(env.feed.getSnapshot().tasks[0].status, "done");
  assert.equal(calls, 2);
  env.events.dispatchEvent(new Event("online")); await flush();
  assert.equal(calls, 3);
  stop();
});

test("temporary failures retain tasks and the next poll recovers", async () => {
  let offline = true;
  const env = environment(async () => {
    if (offline) throw new Error("offline");
    return [{ id: 2, status: "pending" }];
  }, { initialTasks: [{ id: 1, status: "pending" }] });
  const stop = env.feed.subscribe(() => {}); await flush();
  assert.equal(env.feed.getSnapshot().tasks[0].id, 1);
  assert.match(env.feed.getSnapshot().error, /Unable to load/);
  offline = false; env.tick(); await flush();
  assert.equal(env.feed.getSnapshot().tasks[0].id, 2);
  assert.equal(env.feed.getSnapshot().error, "");
  stop();
});

test("access denial clears previously loaded tasks", async () => {
  const env = environment(async () => { throw { response: { status: 403, data: { detail: "Access denied" } } }; }, { initialTasks: [{ id: 1 }] });
  const stop = env.feed.subscribe(() => {}); await flush();
  assert.equal(env.feed.getSnapshot().tasks, null);
  assert.equal(env.feed.getSnapshot().error, "Access denied");
  stop();
});

test("logout stops timers and ignores responses from the previous account", async () => {
  let release, updates = 0, idle = 0, calls = 0;
  const env = environment(() => { calls++; return new Promise((resolve) => { release = resolve; }); }, { onIdle: () => idle++ });
  const stop = env.feed.subscribe(() => updates++); await Promise.resolve();
  stop(); release([{ id: 1 }]); await flush();
  env.events.dispatchEvent(new Event("focus")); env.tick(); await flush();
  assert.equal(calls, 1);
  assert.equal(updates, 0);
  assert.equal(env.feed.getSnapshot().tasks, null);
  assert.equal(env.intervals.size, 0);
  assert.equal(idle, 1);
});

test("a development remount does not discard an active shared feed", async () => {
  let idle = 0;
  const env = environment(async () => [], { onIdle: () => idle++ });
  const first = env.feed.subscribe(() => {});
  first();
  const second = env.feed.subscribe(() => {}); await flush();
  assert.equal(idle, 0);
  assert.equal(env.intervals.size, 1);
  second(); await flush();
  assert.equal(idle, 1);
});
