import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = stripTypeScriptTypes(readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""));
const a = "84c3cf98-35f6-45ee-a440-edc154e93851", b = "763e96b0-d47d-43fc-b86c-ef49c73ba559", empty = "16b4d08e-48eb-4de5-aeea-c63e55726893";
const context = (role, store = a) => ({ user: { id: role === "super_admin" ? "global" : "admin-a" }, profile: { id: "admin-a", role, store_id: role === "super_admin" ? null : a }, ...(role === "super_admin" ? { activeStoreId: store } : {}) });

function fixture() {
  const writes = [];
  const tables = {
    profiles: [{ id: "admin-a", role: "admin", store_id: a }, { id: "employee-a", role: "employee", store_id: a }, { id: "employee-b", role: "employee", store_id: b }],
    crm_datasets: [{ id: 1, store_id: a, owner_id: "admin-a" }, { id: 2, store_id: b, owner_id: "employee-b" }, { id: 3, store_id: a, owner_id: "global" }],
    crm_customer_records: [{ id: 11, dataset_id: 1 }, { id: 22, dataset_id: 2 }],
    crm_visits: [{ id: 1, store_id: a, owner_id: "admin-a" }, { id: 2, store_id: b, owner_id: "employee-b" }],
    crm_reminders: [{ id: 1, store_id: a, owner_id: "global", text: "A", reminder_at: "2099-01-01" }, { id: 2, store_id: b, owner_id: "global", text: "B", reminder_at: "2099-01-01" }],
    crm_assigned_tasks: [{ id: 1, assignee_id: "employee-a" }, { id: 2, assignee_id: "employee-b" }],
    crm_task_notifications: [{ id: 1, task_id: 1, recipient_id: "global", read_at: null }, { id: 2, task_id: 2, recipient_id: "global", read_at: null }],
  };
  const client = {
    from: table => {
      const filters = [];
      let operation = "select", payload, range, options;
      const execute = () => {
        let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        if (operation !== "select") {
          writes.push({ table, operation, payload });
          if (operation === "insert") { rows = [{ id: 100, ...payload }]; (tables[table] ||= []).push(...rows); }
          if (operation === "update") rows.forEach(row => Object.assign(row, payload));
        }
        const count = rows.length;
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return { data: options?.head ? null : rows.map(row => ({ ...row })), count, error: null };
      };
      const query = {
        select: (_columns, config) => { options = config; return query; },
        eq: (key, value) => { filters.push(row => row[key] === value); return query; },
        in: (key, values) => { filters.push(row => values.includes(row[key])); return query; },
        is: (key, value) => { filters.push(row => row[key] === value); return query; },
        lte: (key, value) => { filters.push(row => row[key] <= value); return query; },
        order: () => query,
        limit: () => query,
        range: (from, to) => { range = [from, to]; return query; },
        insert: value => { operation = "insert"; payload = value; return query; },
        update: value => { operation = "update"; payload = value; return query; },
        maybeSingle: async () => { const result = execute(); return { ...result, data: result.data?.[0] || null }; },
        single: async () => { const result = execute(); return { ...result, data: result.data?.[0] || null }; },
        then: (yes, no) => Promise.resolve(execute()).then(yes, no),
      };
      return query;
    },
  };
  const api = new Function("createClient", "Deno", "corsHeaders", `${source};
    serializeDataset = async value => value;
    serializeVisit = async value => value;
    uploadVisitImages = async () => {};
    return { accessibleDatasets, accessibleDataset, accessibleRecord, accessibleVisits, visibleVisit, createImportedDataset, createOrUpdateVisit, routeApi, profileScope };`)(
    () => client, { env: { get: () => "test" }, serve: () => {} }, {},
  );
  return { ...api, writes, route: (ctx, path, method = "GET", body = {}) => api.routeApi(ctx, new Request("http://example.test/" + path, { method }), path, new URLSearchParams(), body, []) };
}

test("all stores, including empty stores, have distinct dataset and visit lists", async () => {
  const app = fixture();
  for (const [store, datasets, visits] of [[a, [1, 3], [1]], [b, [2], [2]], [empty, [], []]]) {
    const ctx = context("super_admin", store);
    assert.deepEqual((await app.accessibleDatasets(ctx)).map(row => row.id), datasets);
    assert.deepEqual((await app.accessibleVisits(ctx)).map(row => row.id), visits);
  }
});

test("a store admin cannot override their store or access another store by record ID", async () => {
  const app = fixture();
  const ctx = { ...context("admin"), activeStoreId: b };
  assert.deepEqual((await app.accessibleDatasets(ctx)).map(row => row.id), [1, 3]);
  for (const operation of [() => app.accessibleDataset(ctx, 2), () => app.accessibleRecord(ctx, 22), () => app.visibleVisit(ctx, 2)]) {
    await assert.rejects(operation, error => error.status === 404);
  }
});

test("Super Admin detail access uses the selected store, not the global profile's null store", async () => {
  const app = fixture();
  assert.equal((await app.accessibleDataset(context("super_admin", a), 1)).id, 1);
  await assert.rejects(app.accessibleDataset(context("super_admin", b), 1), error => error.status === 404);
  assert.equal((await app.accessibleDataset(context("super_admin", b), 2)).id, 2);
});

test("ordinary users are restricted to their own records inside their store", async () => {
  const app = fixture();
  assert.deepEqual((await app.accessibleDatasets(context("employee"))).map(row => row.id), [1]);
  await assert.rejects(app.accessibleDataset(context("employee"), 3), error => error.status === 404);
});

test("missing store assignments and global business requests fail closed", async () => {
  const app = fixture();
  await assert.rejects(app.accessibleDatasets({ user: { id: "admin-a" }, profile: { role: "admin" } }), error => error.status === 403);
  for (const path of ["dashboard", "datasets", "customers", "sales", "attendance", "reminders", "admin/summary", "admin/tasks"]) {
    await assert.rejects(app.route(context("super_admin", ""), path), error => error.status === 400);
  }
  assert.equal(app.writes.length, 0);
});

test("Super Admin imports and manual visits retain their creator and the selected store", async () => {
  const app = fixture();
  const ctx = context("super_admin", a);
  await app.createImportedDataset(ctx, { datasetName: "New list", inspection: { sheets: [{ name: "Sheet1", column_names: [], field_keys: [] }] } });
  assert.equal(app.writes[0].payload.store_id, a);
  assert.equal(app.writes[0].payload.owner_id, "global");
  await app.createOrUpdateVisit(ctx, null, { visit_mode: "manual", client_name: "New client", visit_date: "2026-11-06", status: "healthy" }, []);
  for (const write of app.writes.filter(row => ["crm_manual_clients", "crm_visits"].includes(row.table))) {
    assert.equal(write.payload.store_id, a);
    assert.equal(write.payload.owner_id, "global");
  }
});

test("reminders and task notifications cannot be read or changed from another selected store", async () => {
  const app = fixture();
  const ctx = context("super_admin", a);
  await assert.rejects(app.route(ctx, "reminders/2", "PATCH", { text: "Changed" }), error => error.status === 404);
  const notifications = await (await app.route(ctx, "task-notifications")).json();
  assert.deepEqual(notifications.results.map(row => row.id), [1]);
  assert.equal(notifications.unread_count, 1);
  await assert.rejects(app.route(ctx, "task-notifications/2", "PATCH"), error => error.status === 404);
});
