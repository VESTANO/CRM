import assert from "node:assert/strict";
import test from "node:test";
import { createProfileReadCache } from "./profileReadCache.js";

test("CRM and Attendance share an in-flight profile read and retain account fields", async () => {
  let resolve;
  let requests = 0;
  const cache = createProfileReadCache(() => {
    requests += 1;
    return new Promise((done) => { resolve = done; });
  });
  const crm = cache.read("one");
  const attendance = cache.read("one");
  assert.equal(crm, attendance);
  await Promise.resolve();
  resolve({ id: "one", role: "employee", active: false, shift_start_time: "09:30:00" });
  const profile = await attendance;
  assert.equal(requests, 1);
  assert.equal(profile.active, false);
  assert.equal(profile.role, "employee");
  assert.equal(profile.shift_start_time, "09:30:00");
  assert.equal(Object.isFrozen(profile), true);
});

test("profiles expire quickly and reads are isolated by account", async () => {
  let time = 0;
  const requests = [];
  const cache = createProfileReadCache(async (id) => { requests.push(id); return { id }; }, { now: () => time });
  const first = await cache.read("one");
  assert.equal(await cache.read("one"), first);
  await cache.read("two");
  time = 5_000;
  assert.notEqual(await cache.read("one"), first);
  assert.deepEqual(requests, ["one", "two", "one"]);
});

test("clearing at sign-out or an auth update does not reuse a pending old profile", async () => {
  const pending = [];
  const cache = createProfileReadCache((id) => new Promise((resolve) => pending.push({ id, resolve })));
  const old = cache.read("one");
  await Promise.resolve();
  cache.clear();
  const current = cache.read("one");
  await Promise.resolve();
  pending[0].resolve({ id: "one", role: "admin" });
  await old;
  pending[1].resolve({ id: "one", role: "employee" });
  assert.equal((await current).role, "employee");
  assert.equal((await cache.read("one")).role, "employee");
});

test("a failed or mismatched profile is not cached, and an anonymous read does no work", async () => {
  let requests = 0;
  const cache = createProfileReadCache(async (id) => {
    requests += 1;
    if (requests === 1) throw new Error("Offline");
    if (requests === 2) return { id: "another" };
    return { id };
  });
  assert.equal(await cache.read(null), null);
  await assert.rejects(cache.read("one"), /Offline/);
  await assert.rejects(cache.read("one"), /does not match/);
  assert.equal((await cache.read("one")).id, "one");
  assert.equal(requests, 3);
});
