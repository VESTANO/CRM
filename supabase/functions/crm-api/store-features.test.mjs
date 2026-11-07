import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const routeSource = stripTypeScriptTypes(source.slice(source.indexOf("async function routeApi("), source.indexOf("async function profilesWithCounts(")));
const featureSource = stripTypeScriptTypes(source.slice(source.indexOf("async function storeFeaturesFor("), source.indexOf("function applyProfileScope(")));
const defaults = { dashboard: true, customers: true, sales: true, attendance: true, callbacks: true, reminders: true, reports: true, tasks: true };

function setup(disabled = []) {
  const checked = [];
  const features = Object.fromEntries(["dashboard", "customers", "sales", "attendance", "callbacks", "reminders", "reports", "tasks"].map((key) => [key, !disabled.includes(key)]));
  const routeApi = new Function("requireStoreFeature", "storeFeaturesFor", "json", `${routeSource}; return routeApi;`)(
    async (_ctx, feature) => {
      checked.push(feature);
      if (!features[feature]) throw Object.assign(new Error("This feature is not enabled for your store."), { status: 403 });
    },
    async () => features,
    (status, body) => ({ status, body }),
  );
  const request = (path, method = "GET") => routeApi({}, { method }, path, new URLSearchParams(), {}, []);
  return { checked, request };
}

test("disabled modules reject direct API URLs before their handlers run", async () => {
  const app = setup(["dashboard", "reports", "customers", "sales", "attendance", "callbacks", "reminders", "tasks"]);
  for (const [path, expected] of [
    ["dashboard/", "dashboard"], ["reports/summary/", "reports"], ["datasets/", "customers"], ["customers/1/", "customers"], ["import/", "customers"],
    ["admin/users/u/datasets/", "customers"], ["sales/visits/", "sales"],
    ["targets/", "sales"], ["admin/targets/", "sales"],
    ["attendance/", "attendance"], ["overtime/", "attendance"],
    ["callbacks/", "callbacks"], ["reminders/", "reminders"], ["push/", "reminders"],
    ["tasks/", "tasks"], ["task-notifications/", "tasks"], ["admin/tasks/", "tasks"],
  ]) {
    await assert.rejects(app.request(path), { status: 403 }, path);
    assert.equal(app.checked.at(-1), expected);
  }
});

test("authenticated store feature lookup returns the effective switches", async () => {
  const app = setup(["attendance", "sales"]);
  const response = await app.request("store/features/");
  assert.equal(response.status, 200);
  assert.equal(response.body.features.attendance, false);
  assert.equal(response.body.features.sales, false);
  assert.deepEqual(app.checked, []);
});

test("store lookup uses selected store and global Super Admin defaults", async () => {
  const queried = [];
  const client = { from: (table) => {
    assert.equal(table, "crm_stores");
    return { select: (columns) => {
      assert.equal(columns, "features");
      return { eq: (field, value) => {
        assert.equal(field, "id"); queried.push(value);
        return { maybeSingle: async () => ({ data: { features: { ...defaults, sales: false } }, error: null }) };
      } };
    } };
  } };
  const { storeFeaturesFor, requireStoreFeature } = new Function("profileScope", "adminClient", "checkDb", "fail", "defaultStoreFeatures", `${featureSource}; return { storeFeaturesFor, requireStoreFeature };`)(
    ctx => ctx.storeId,
    client,
    error => { if (error) throw error; },
    (status, message) => { throw Object.assign(new Error(message), { status }); },
    defaults,
  );
  assert.deepEqual(await storeFeaturesFor({ storeId: null }), defaults);
  assert.deepEqual(queried, []);
  await assert.rejects(requireStoreFeature({ storeId: "store-a" }, "sales"), { status: 403 });
  assert.deepEqual(queried, ["store-a"]);
  await requireStoreFeature({ storeId: "store-a" }, "attendance");
});
