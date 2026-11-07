import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { salesRequestParams } from "../utils/sales.js";

const source = readFileSync(new URL("./api.js", import.meta.url), "utf8");
const warmerSource = source.slice(source.indexOf("export async function warmNavigationData"))
  .replace("export async function", "async function") + "\nwarmNavigationData;";

function warmer({ hold = [] } = {}) {
  const calls = [], releases = new Map();
  let active = 0, peak = 0;
  const request = (name) => async () => {
    calls.push(name);
    peak = Math.max(peak, ++active);
    try {
      if (hold.includes(name)) await new Promise((resolve) => releases.set(name, resolve));
      else await Promise.resolve();
      return name;
    } finally { active--; }
  };
  const api = (name, methods) => Object.fromEntries(methods.map((method) => [method, request(`${name}.${method}`)]));
  const run = vm.runInNewContext(warmerSource, {
    dashboardApi: api("dashboard", ["summary"]), targetsApi: api("targets", ["list"]),
    datasetsApi: api("datasets", ["list"]), customersApi: api("customers", ["list"]),
    salesApi: api("sales", ["list", "summary"]), callbacksApi: api("callbacks", ["list"]),
    remindersApi: api("reminders", ["list"]), tasksApi: api("tasks", ["list"]),
    adminApi: api("admin", ["summary", "listUsers", "targets", "tasks"]),
  });
  return { run, calls, releases, peak: () => peak };
}

test("one slow secondary endpoint does not block warming other pages", async () => {
  const queue = warmer({ hold: ["targets.list"] });
  const result = queue.run();
  await new Promise(setImmediate);
  assert.ok(queue.calls.includes("tasks.list"));
  assert.ok(!queue.calls.some((call) => call.startsWith("admin.")));
  assert.equal(queue.peak(), 2);
  queue.releases.get("targets.list")();
  assert.equal((await result).length, 9);
});

test("admin prefetch includes the user directory and remains bounded", async () => {
  const queue = warmer();
  const result = await queue.run(true);
  assert.equal(result.length, 13);
  assert.ok(queue.calls.includes("admin.listUsers"));
  assert.equal(queue.peak(), 2);
});

test("leaving the workspace cancels queued background work", async () => {
  const queue = warmer({ hold: ["dashboard.summary", "targets.list"] });
  const controller = new AbortController();
  const result = queue.run(true, { signal: controller.signal });
  controller.abort();
  queue.releases.get("dashboard.summary")();
  queue.releases.get("targets.list")();
  await result;
  assert.equal(queue.calls.length, 2);
});

test("an already-cancelled queue makes no requests", async () => {
  const queue = warmer();
  const controller = new AbortController();
  controller.abort();
  await queue.run(true, { signal: controller.signal });
  assert.equal(queue.calls.length, 0);
});

test("Sales cache keys distinguish server filters and pages", () => {
  assert.notDeepEqual(salesRequestParams({ q: "Asha", dataset_name: "Kochi", payment_status: "completed" }), salesRequestParams());
  assert.deepEqual(salesRequestParams({ status: "converted", date_from: "2026-11-01", date_to: "2026-11-03", q: "Asha" }), {
    status: "converted", date_from: "2026-11-01", date_to: "2026-11-03", q: "Asha", dataset_name: undefined, payment_status: undefined, page: undefined,
  });
  assert.notDeepEqual(salesRequestParams({ page: 2 }), salesRequestParams({ page: 1 }));
  assert.deepEqual(salesRequestParams({ page: "1", q: "  " }), salesRequestParams());
});
