import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionMonitor } from "./connectionMonitor.js";
import { withTimeout } from "./withTimeout.js";

function clock() {
  let next = 0;
  const timers = new Map(), intervals = new Map(), listeners = new Map();
  const host = {
    setTimeout: (callback) => { timers.set(++next, callback); return next; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => { intervals.set(++next, callback); return next; },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback),
    emit: (name) => { for (const callback of listeners.get(name) || []) callback(); },
  };
  return { host, timers, intervals, listenerCount: () => [...listeners.values()].reduce((count, list) => count + list.size, 0) };
}
const settle = () => new Promise(setImmediate);

test("focus/online/interval bursts coalesce; hiding aborts probes and all handles are released", async () => {
  const state = clock();
  const doc = { ...state.host, hidden: false }, network = { onLine: true }, calls = [], statuses = [];
  const monitor = createConnectionMonitor({ host: state.host, document: doc, network, onStatus: value => statuses.push(value), probe: signal => new Promise(resolve => calls.push({ signal, resolve })) });
  await settle();
  state.host.emit("focus"); state.host.emit("online");
  for (const tick of state.intervals.values()) tick();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.timers.size, 1);
  assert.equal(state.listenerCount(), 4);
  doc.hidden = true; state.host.emit("visibilitychange");
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.timers.size, 0);
  await monitor.check();
  assert.equal(calls.length, 1);
  calls[0].resolve(false); await settle();
  assert.deepEqual(statuses, [], "hidden probe completion must not change connection state");
  doc.hidden = false; state.host.emit("visibilitychange"); await settle();
  assert.equal(calls.length, 2);
  monitor.dispose();
  calls[1].resolve(false); await settle();
  assert.deepEqual(statuses, [], "unmounted probe completion must not change state");
  assert.equal(state.listenerCount(), 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.intervals.size, 0);
});

test("offline wins over a late successful probe and visible recovery retries", async () => {
  const state = clock();
  const doc = { ...state.host, hidden: false }, network = { onLine: true }, calls = [], statuses = [];
  const monitor = createConnectionMonitor({ host: state.host, document: doc, network, onStatus: value => statuses.push(value), probe: signal => new Promise(resolve => calls.push({ signal, resolve })) });
  await settle();
  network.onLine = false; state.host.emit("offline");
  calls[0].resolve(true); await settle();
  assert.deepEqual(statuses, [false]);
  network.onLine = true; state.host.emit("online"); await settle();
  calls[1].resolve(true); await settle();
  assert.deepEqual(statuses, [false, true]);
  monitor.dispose();
});

test("100 monitor mount/dispose cycles retain zero listeners or timer handles", async () => {
  const state = clock(), doc = { ...state.host, hidden: false };
  for (let index = 0; index < 100; index += 1) {
    const monitor = createConnectionMonitor({ host: state.host, document: doc, network: { onLine: true }, onStatus: () => {}, probe: async () => true });
    await settle();
    monitor.dispose();
  }
  assert.equal(state.listenerCount(), 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.intervals.size, 0);
});

test("immediate disposal cancels a queued health probe before it starts", async () => {
  const state = clock();
  let calls = 0;
  const monitor = createConnectionMonitor({ host: state.host, document: { ...state.host, hidden: false }, network: { onLine: true }, onStatus: () => assert.fail("disposed monitor published"), probe: async () => { calls += 1; return true; } });
  monitor.dispose();
  await settle();
  assert.equal(calls, 0);
});

test("session timeout handles are released after success, rejection, and timeout", async () => {
  const state = clock();
  for (let index = 0; index < 100; index += 1) assert.equal(await withTimeout(Promise.resolve(index), 15_000, "Timed out", state.host), index);
  assert.equal(state.timers.size, 0);
  await assert.rejects(withTimeout(Promise.reject(new Error("Offline")), 15_000, "Timed out", state.host), /Offline/);
  assert.equal(state.timers.size, 0);
  const pending = withTimeout(new Promise(() => {}), 15_000, "Timed out", state.host);
  for (const expire of state.timers.values()) expire();
  await assert.rejects(pending, /Timed out/);
  assert.equal(state.timers.size, 0);
});
