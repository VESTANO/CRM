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
  const records = [
    { id: "punch-a", user_id: "employee-vestano", punched_at: "2026-11-06T09:00:00Z", updated_at: "2026-11-06T09:00:00Z" },
    { id: "punch-b", user_id: "employee-other", punched_at: "2026-11-06T09:00:00Z", updated_at: "2026-11-06T09:00:00Z" },
  ];
  const client = {
    auth: { onAuthStateChange: () => {} },
    functions: { invoke: async (name, options) => { requests.push({ name, options }); return { data: { ok: true } }; } },
    rpc: async (name, params) => { requests.push({ name, params }); return { data: { hours: 8, employees: 1 } }; },
    from: table => {
      const filters = [];
      const query = {
        select: () => query,
        eq: (key, value) => { filters.push([key, value]); return query; },
        in: (key, value) => { filters.push([key, value]); return query; },
        order: () => query,
        range: () => query,
        limit: () => query,
        abortSignal: () => query,
        then: (resolve, reject) => {
          reads.push({ table, filters });
          const rows = table === "profiles" ? profiles : table === "attendance_records" ? records : table === "timesheet_entries"
            ? records.map(row => ({ id: row.id, user_id: row.user_id, work_date: "2026-11-06", employee_id: row.user_id })) : [];
          return Promise.resolve({ data: rows.filter(row => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value)) }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const api = new Function("createReadCache", "crmSupabase", "CRM_SUPABASE_URL", "CRM_SUPABASE_PUBLISHABLE_KEY", "readCrmProfile", "createAttendanceFeed", "activeStoreId",
    `${source}; return { fetchAttendanceEmployees, resolveAttendanceProfile, manageLiveEmployee, fetchLiveTimesheet, fetchAttendanceDashboardTotals, attendanceSource };`)(
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

test("Attendance history, changes, and reconciliation only query the selected store's members", async () => {
  const app = fixture();
  const profile = { id: "global-admin", role: "super_admin" };
  app.selectStore(vestano);
  const source = app.attendanceSource({ profile });
  await source.version();
  const page = await source.page({ limit: 100 });
  assert.deepEqual(page.map(row => row.id), ["punch-a"]);
  assert.equal(source.accepts({ user_id: "employee-other" }), false);
  assert.equal(source.accepts({ user_id: "employee-vestano" }), true);
  await source.ids({ limit: 100 });
  const metadata = await source.metadata();
  assert.equal(metadata.employees.some(row => row.id === "employee-other"), false);
  assert.deepEqual(metadata.devices, []);
  for (const read of app.reads.filter(read => read.table === "attendance_records")) {
    assert.ok(read.filters.some(([key, value]) => key === "user_id" && Array.isArray(value) && !value.includes("employee-other")));
  }
  app.selectStore(otherStore);
  await assert.rejects(source.page({ limit: 100 }), /store has changed/);
});

test("a foreign employee filter cannot widen the store's Attendance query", async () => {
  const app = fixture();
  app.selectStore(vestano);
  const source = app.attendanceSource({ profile: { id: "global-admin", role: "super_admin" }, userId: "employee-other" });
  assert.deepEqual(await source.page({ limit: 100 }), []);
});

test("Timesheets stay separate across selected stores and ordinary employees", async () => {
  const app = fixture();
  const profile = { id: "global-admin", role: "super_admin" };
  app.selectStore(vestano);
  assert.deepEqual((await app.fetchLiveTimesheet({ profile })).map(row => row.id), ["punch-a"]);
  app.selectStore(otherStore);
  assert.deepEqual((await app.fetchLiveTimesheet({ profile })).map(row => row.id), ["punch-b"]);
  app.selectStore("");
  await assert.rejects(app.fetchLiveTimesheet({ profile }), /Open a store/);
  const employee = { id: "employee-vestano", role: "employee", storeId: vestano };
  assert.deepEqual((await app.fetchLiveTimesheet({ profile: employee })).map(row => row.id), ["punch-a"]);
});

test("overview totals send the selected store rather than requesting global totals", async () => {
  const app = fixture();
  app.selectStore(vestano);
  await app.fetchAttendanceDashboardTotals({ id: "global-admin", role: "super_admin" });
  assert.deepEqual(app.requests[0], { name: "get_store_dashboard_totals", params: { p_store_id: vestano } });
});
