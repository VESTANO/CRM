import assert from "node:assert/strict";
import test from "node:test";
import { createReadCache } from "./readCache.js";

test("concurrent navigation reads share one request and reuse fresh results", async () => {
  const cache = createReadCache();
  let calls = 0;
  const load = async () => { calls++; return ["attendance"]; };
  const first = cache.read("user-1|attendance", load);
  assert.equal(cache.read("user-1|attendance", load), first);
  assert.deepEqual(await first, ["attendance"]);
  assert.deepEqual(await cache.read("user-1|attendance", load), ["attendance"]);
  assert.equal(calls, 1);
});

test("expired data is fetched again", async () => {
  let clock = 0, calls = 0;
  const cache = createReadCache({ now: () => clock });
  const load = async () => ++calls;
  assert.equal(await cache.read("attendance", load, 15), 1);
  clock = 15;
  assert.equal(await cache.read("attendance", load, 15), 2);
});

test("users and filters never share cached responses", async () => {
  const cache = createReadCache();
  assert.equal(await cache.read("user-1|all", async () => "all"), "all");
  assert.equal(await cache.read("user-2|all", async () => "other user"), "other user");
  assert.equal(await cache.read("user-1|today", async () => "today"), "today");
});

test("normal attendance polling fetches new data on its next tick", async () => {
  let clock = 0, calls = 0;
  const cache = createReadCache({ now: () => clock });
  const load = async () => ++calls;
  assert.equal(await cache.read("attendance", load), 1);
  clock = 15_000;
  assert.equal(await cache.read("attendance", load), 2);
});

test("failed reads can be retried", async () => {
  const cache = createReadCache();
  await assert.rejects(cache.read("attendance", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.read("attendance", async () => "recovered"), "recovered");
});

test("clearing after a mutation prevents an older request restoring stale data", async () => {
  const cache = createReadCache();
  let resolveOld;
  const old = cache.read("attendance", () => new Promise((resolve) => { resolveOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.read("attendance", async () => "new"), "new");
  resolveOld("old");
  assert.equal(await old, "old");
  assert.equal(await cache.read("attendance", async () => "unexpected"), "new");
});
