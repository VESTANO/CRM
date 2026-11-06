import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createReadCache } from "./readCache.js";

const source = readFileSync(new URL("./attendanceSupabase.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const vestano = "84c3cf98-35f6-45ee-a440-edc154e93851";
const otherStore = "763e96b0-d47d-43fc-b86c-ef49c73ba559";

function fixture() {
  let selectedStore = "";
  const reads = [], requests = [];
  const rawProfile = { id: "admin", store_id: vestano, employee_id: "ADMIN01", name: "Admin", active: true, role: "admin" };
  const profiles = [rawProfile,
    { id: "employee-vestano", store_id: vestano, name: "Vestano employee", role: "employee" },
    { id: "employee-other", store_id: otherStore, name: "Other store employee", role: "employee" },
  ];
  const client = {
    auth: { onAuthStateChange: () => {} },
    functions: { invoke: async (name, options) => { requests.push({ name, options }); return { data: { ok: true } }; } },
    from: table => {
      const filters = [];
      const query = {
        select: () => query,
        eq: (key, value) => { filters.push([key, value]); return query; },
        order: async () => {
          reads.push({ table, filters });
          return { data: profiles.filter(row => filters.every(([key, value]) => row[key] === value)) };
        },
      };
      return query;
    },
  };
  const api = new Function("createReadCache", "crmSupabase", "CRM_SUPABASE_URL", "CRM_SUPABASE_PUBLISHABLE_KEY", "readCrmProfile", "createAttendanceFeed", "activeStoreId",
    `${source}; return { fetchAttendanceEmployees, resolveAttendanceProfile, manageLiveEmployee };`)(
    createReadCache, client, "http://example.test", "test-key", async () => rawProfile,
    () => { throw new Error("Unexpected attendance feed"); }, () => selectedStore,
  );
  return { ...api, reads, requests, selectStore: id => { selectedStore = id; } };
}

test("the Attendance profile retains the CRM store assignment", async () => {
  const app = fixture();
  const profile = await app.resolveAttendanceProfile({ user: { id: "admin" } });
  assert.equal(profile.storeId, vestano);
  const employees = await app.fetchAttendanceEmployees(profile);
  assert.deepEqual(employees.map(row => row.id), ["admin", "employee-vestano"]);
});

test("employee lists and their cache stay separate when a Super Admin switches stores", async () => {
  const app = fixture();
  const profile = { id: "global-admin", role: "super_admin", storeId: "" };
  app.selectStore(vestano);
  assert.deepEqual((await app.fetchAttendanceEmployees(profile)).map(row => row.id), ["admin", "employee-vestano"]);
  app.selectStore(otherStore);
  assert.deepEqual((await app.fetchAttendanceEmployees(profile)).map(row => row.id), ["employee-other"]);
  app.selectStore(vestano);
  assert.deepEqual((await app.fetchAttendanceEmployees(profile)).map(row => row.id), ["admin", "employee-vestano"]);
  assert.equal(app.reads.length, 2);
  assert.deepEqual(app.reads.map(read => read.filters), [[["store_id", vestano]], [["store_id", otherStore]]]);
});

test("store admins always list their own store even if session storage contains another store", async () => {
  const app = fixture();
  app.selectStore(otherStore);
  await app.fetchAttendanceEmployees({ id: "admin", role: "admin", storeId: vestano });
  assert.deepEqual(app.reads[0].filters, [["store_id", vestano]]);
});

test("global admins must select a store; employees can only fetch their own profile", async () => {
  const app = fixture();
  await assert.rejects(app.fetchAttendanceEmployees({ id: "global-admin", role: "super_admin" }), /Open a store/);
  const employee = { id: "employee", role: "employee", storeId: vestano };
  assert.deepEqual(await app.fetchAttendanceEmployees(employee), [employee]);
  assert.equal(app.reads.length, 0);
});

test("employee creation sends the selected Vestano store to the Edge Function and expires cached lists", async () => {
  const app = fixture();
  app.selectStore(vestano);
  const profile = { id: "global-admin", role: "super_admin", storeId: "" };
  await app.fetchAttendanceEmployees(profile);
  await app.manageLiveEmployee("create", { employeeId: "EMP21", name: "New employee", email: "new@example.test" });
  assert.equal(app.requests[0].name, "admin-users");
  assert.deepEqual(app.requests[0].options.headers, { "x-crm-store-id": vestano });
  assert.equal(app.requests[0].options.body.action, "create");
  await app.fetchAttendanceEmployees(profile);
  assert.equal(app.reads.length, 2);
});

test("store-admin requests can omit the selected-store header and rely on server authorization", async () => {
  const app = fixture();
  await app.manageLiveEmployee("update", { userId: "employee", active: true });
  assert.deepEqual(app.requests[0].options.headers, {});
});
