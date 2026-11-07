import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./api.js", import.meta.url), "utf8");
const cacheSource = source.slice(source.indexOf("function cacheKey("), source.indexOf("export function getApiPerformanceSnapshot("))
  .replace(/^export /gm, "");
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let store = "vestano";
  let onStoreChange;
  const requests = [], held = [];
  let hold = false;
  const api = new Function("apiClient", "activeStoreId", "subscribeStore", "clearAttendanceReadCache", `
    const getCache = new Map(), pendingImports = new Map();
    let cacheScope = "user:super", cacheGeneration = 0;
    const GET_CACHE_TTL = 120000, STALE_CACHE_TTL = 600000;
    const cacheDiagnostics = {hits:0,misses:0,deduplicated:0,staleRenders:0};
    ${cacheSource}
    return {cachedGet, peekCachedResponse, setApiCacheScope, invalidateApiCache, cacheSize: () => getCache.size};`)(
    { get: (url, config) => {
      requests.push({ url, config });
      const result = { data: { store: config.crmStoreId, url } };
      if (!hold) return Promise.resolve(result);
      const pending = deferred(); held.push({ ...pending, result }); return pending.promise;
    } }, () => store, callback => { onStoreChange = callback; }, () => {},
  );
  return { ...api, requests, held, hold: () => { hold = true; }, selectStore: (value, notify = true) => { store = value; if (notify) onStoreChange(); } };
}

test("dashboard, customers, reports, callbacks, and sales caches are separated for every store", async () => {
  const app = fixture();
  const paths = ["/dashboard/", "/customers/", "/reports/", "/callbacks/", "/sales/"];
  for (const path of paths) await app.cachedGet(path);
  app.selectStore("store-b", false);
  for (const path of paths) assert.equal(app.peekCachedResponse(path), null);
  for (const path of paths) assert.equal((await app.cachedGet(path)).data.store, "store-b");
  app.selectStore("empty-store", false);
  for (const path of paths) assert.equal(app.peekCachedResponse(path), null);
  app.selectStore("vestano", false);
  for (const path of paths) assert.equal(app.peekCachedResponse(path).data.store, "vestano");
});

test("an old pending request cannot repopulate caches after switching away and back", async () => {
  const app = fixture();
  app.hold();
  const oldRequest = app.cachedGet("/dashboard/");
  app.selectStore("store-b");
  app.selectStore("vestano");
  app.held[0].resolve(app.held[0].result);
  await oldRequest;
  assert.equal(app.peekCachedResponse("/dashboard/"), null);
});

test("signed-out users cannot reuse a pending previous account's response", async () => {
  const app = fixture();
  app.hold();
  const pending = app.cachedGet("/customers/");
  app.setApiCacheScope(null);
  app.held[0].resolve(app.held[0].result);
  await pending;
  assert.equal(app.peekCachedResponse("/customers/"), null);
});

test("mutation invalidation only targets matching URLs in the current store", async () => {
  const app = fixture();
  await app.cachedGet("/dashboard/");
  await app.cachedGet("/customers/");
  app.selectStore("store-b", false);
  await app.cachedGet("/dashboard/");
  app.invalidateApiCache("/dashboard/");
  assert.equal(app.peekCachedResponse("/dashboard/"), null);
  app.selectStore("vestano", false);
  assert.equal(app.peekCachedResponse("/dashboard/").data.store, "vestano");
});

test("a pre-mutation read cannot repopulate data after targeted invalidation", async () => {
  const app = fixture();
  app.hold();
  const staleRead = app.cachedGet("/customers/");
  app.invalidateApiCache("/customers/");
  const freshRead = app.cachedGet("/customers/");
  const fresh = { data: { revision: 2 } };
  app.held[1].resolve(fresh);
  await freshRead;
  app.held[0].resolve({ data: { revision: 1 } });
  await staleRead;
  assert.equal(app.peekCachedResponse("/customers/"), fresh);
});

test("a superseded failed read cannot erase its replacement", async () => {
  const app = fixture();
  app.hold();
  const staleRead = app.cachedGet("/customers/");
  app.invalidateApiCache("/customers/");
  const freshRead = app.cachedGet("/customers/");
  app.held[1].resolve(app.held[1].result);
  await freshRead;
  app.held[0].reject(new Error("Old request failed"));
  await assert.rejects(staleRead, /Old request/);
  assert.equal(app.peekCachedResponse("/customers/"), app.held[1].result);
});

test("literal query delimiters cannot collide with separate filters", async () => {
  const app = fixture();
  await app.cachedGet("/customers/", { params: { q: "Alice&status=interested" } });
  assert.equal(app.peekCachedResponse("/customers/", { params: { q: "Alice", status: "interested" } }), null);
});

test("long sessions with 1,000 distinct searches retain at most 200 cached reads", async () => {
  const app = fixture();
  for (let page = 0; page < 1000; page += 1) await app.cachedGet("/customers/", { params: { q: `client-${page}` } });
  assert.ok(app.cacheSize() <= 200, `retained ${app.cacheSize()} responses`);
  assert.equal(app.peekCachedResponse("/customers/", { params: { q: "client-0" } }), null);
  assert.ok(app.peekCachedResponse("/customers/", { params: { q: "client-999" } }));
});

test("the request's store is captured before asynchronous session restoration", async () => {
  let store = "vestano", interceptor;
  const session = deferred();
  const interceptorSource = source.slice(source.indexOf("apiClient.interceptors.request.use("), source.indexOf("function apiError("));
  new Function("apiClient", "crmSupabase", "CRM_SUPABASE_PUBLISHABLE_KEY", "activeStoreId", interceptorSource)(
    { interceptors: { request: { use: value => { interceptor = value; } } } },
    { auth: { getSession: () => session.promise } }, "public-test-key", () => store,
  );
  const headers = new Map();
  const pending = interceptor({ headers });
  store = "store-b";
  session.resolve({ data: { session: null } });
  await pending;
  assert.equal(headers.get("x-crm-store-id"), "vestano");
});
