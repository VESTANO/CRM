import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Run the real Edge handler with in-memory clients. No real accounts are created.
const source = stripTypeScriptTypes(readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, ""));
const vestano = "84c3cf98-35f6-45ee-a440-edc154e93851";
const otherStore = "763e96b0-d47d-43fc-b86c-ef49c73ba559";
const missingStore = "00000000-0000-4000-8000-000000000001";
const employee = {
  id: "employee", store_id: vestano, employee_id: "EMP01", name: "Existing employee",
  email: "existing@example.test", role: "employee", active: false,
  department: "Sales", manager: "Manager", shift_start_time: "09:30", shift_end_time: "17:30",
};
const newEmployee = {
  employeeId: "EMP21", name: "New employee", email: "new@example.test",
  department: "Architecture", role: "employee", password: "example-password-123",
};

function fixture({ role = "admin", storeId = vestano, active = true, targets = [], profileError = false, authError = false, signedIn = true } = {}) {
  const caller = { id: "caller", role, active, store_id: storeId };
  const rows = [caller, ...targets.map(row => ({ ...row }))];
  const authCreates = [], authUpdates = [], authDeletes = [], writes = [];
  let handler;
  const project = (row, columns) => !row ? row : columns === "*" ? { ...row } : Object.fromEntries(columns.split(",").map(key => [key.trim(), row[key.trim()]]));
  const adminClient = {
    auth: { admin: {
      createUser: async body => { authCreates.push(body); return { data: { user: { id: "new-user" } } }; },
      updateUserById: async (id, body) => { authUpdates.push({ id, body }); return authError ? { error: new Error("Auth update failed") } : {}; },
      deleteUser: async id => { authDeletes.push(id); return {}; },
    } },
    from: table => {
      const filters = [];
      let columns = "*", operation = "select", payload;
      const execute = () => {
        const tableRows = table === "crm_stores" ? [{ id: vestano }, { id: otherStore }] : rows;
        const matches = tableRows.filter(row => filters.every(([key, value]) => row[key] === value));
        if (operation === "select") return { data: matches.map(row => project(row, columns)) };
        writes.push({ table, operation, payload: { ...payload }, filters: [...filters] });
        if (profileError && operation === "upsert") return { data: null, error: new Error("Profile write failed") };
        if (payload.role !== "super_admin" && !payload.store_id) return { data: null, error: new Error("Missing store") };
        if (operation === "upsert") {
          rows.push({ ...payload });
          return { data: [project({ ...payload }, columns)] };
        }
        matches.forEach(row => Object.assign(row, payload));
        return { data: matches.map(row => project(row, columns)) };
      };
      const single = () => {
        const result = execute();
        return { ...result, data: result.data?.[0] || null };
      };
      const query = {
        select: (value = "*") => { columns = value; return query; },
        eq: (key, value) => { filters.push([key, value]); return query; },
        upsert: value => { payload = value; operation = "upsert"; return query; },
        update: value => { payload = value; operation = "update"; return query; },
        single: async () => single(),
        maybeSingle: async () => single(),
        then: (resolve, reject) => Promise.resolve(execute()).then(resolve, reject),
      };
      return query;
    },
  };
  const userClient = { auth: { getUser: async () => ({ data: { user: signedIn ? { id: caller.id } : null } }) } };
  new Function("createClient", "corsHeaders", "Deno", source)(
    (_url, key) => key === "service-key" ? adminClient : userClient,
    { "Access-Control-Allow-Headers": "authorization, x-crm-store-id" },
    { env: { get: name => name === "SUPABASE_SERVICE_ROLE_KEY" ? "service-key" : "anon-key" }, serve: value => { handler = value; } },
  );
  const request = async (action, body = {}, selectedStore = "") => {
    const response = await handler(new Request("http://example.test/admin-users", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...(selectedStore ? { "x-crm-store-id": selectedStore } : {}) },
      body: JSON.stringify({ action, ...body }),
    }));
    return { status: response.status, data: await response.json() };
  };
  return { request, writes, authCreates, authUpdates, authDeletes, rows };
}

test("a Vestano CRM admin creates the employee in Vestano CRM", async () => {
  const app = fixture();
  const result = await app.request("create", newEmployee);
  assert.equal(result.status, 201);
  assert.equal(result.data.employee.store_id, vestano);
  assert.equal(result.data.employee.employee_id, "EMP21");
  assert.equal(app.writes[0].payload.store_id, vestano);
  assert.equal(app.authCreates.length, 1);
});

test("an admin cannot override their store through the header or request body", async () => {
  const app = fixture();
  const result = await app.request("create", { ...newEmployee, store_id: otherStore, storeId: otherStore }, otherStore);
  assert.equal(result.status, 201);
  assert.equal(result.data.employee.store_id, vestano);
});

test("Super Admins create employees in the selected store, including Vestano CRM", async () => {
  for (const store of [vestano, otherStore]) {
    const app = fixture({ role: "super_admin", storeId: null });
    const result = await app.request("create", { ...newEmployee, store_id: missingStore }, store);
    assert.equal(result.status, 201);
    assert.equal(result.data.employee.store_id, store);
  }
});

test("missing, invalid, or deleted store selections are rejected before account creation", async () => {
  for (const selectedStore of ["", "not-a-store", missingStore]) {
    const app = fixture({ role: "super_admin", storeId: null });
    assert.equal((await app.request("create", newEmployee, selectedStore)).status, 400);
    assert.equal(app.authCreates.length, 0);
    assert.equal(app.writes.length, 0);
  }
  const unassigned = fixture({ storeId: null });
  assert.equal((await unassigned.request("create", newEmployee)).status, 400);
  assert.equal(unassigned.authCreates.length, 0);
});

test("employee roles, inactive callers, and unauthenticated requests cannot create accounts", async () => {
  for (const options of [{ role: "employee" }, { active: false }, { signedIn: false }]) {
    const app = fixture(options);
    assert.ok([401, 403].includes((await app.request("create", newEmployee)).status));
    assert.equal(app.authCreates.length, 0);
    assert.equal(app.writes.length, 0);
  }
});

test("admins and store-scoped Super Admins cannot edit or delete another store's employee", async () => {
  for (const role of ["admin", "super_admin"]) {
    for (const action of ["update", "delete"]) {
      const app = fixture({ role, storeId: role === "super_admin" ? null : vestano, targets: [{ ...employee, store_id: otherStore }] });
      const result = await app.request(action, { userId: employee.id, name: "Changed", password: "changed-password" }, vestano);
      assert.equal(result.status, 404);
      assert.equal(app.writes.length, 0);
      assert.equal(app.authUpdates.length, 0);
      assert.equal(app.authDeletes.length, 0);
    }
  }
});

test("same-store updates preserve the store even when a different store is submitted", async () => {
  const app = fixture({ targets: [employee] });
  const result = await app.request("update", { userId: employee.id, name: "Updated employee", active: true, store_id: otherStore });
  assert.equal(result.status, 200);
  assert.equal(result.data.employee.store_id, vestano);
  assert.equal(result.data.employee.name, "Updated employee");
  assert.ok(app.writes[0].filters.some(([key, value]) => key === "store_id" && value === vestano));
});

test("deletion is allowed only for an inactive employee in the authorized store", async () => {
  const app = fixture({ targets: [employee] });
  assert.equal((await app.request("delete", { userId: employee.id })).status, 200);
  assert.deepEqual(app.authDeletes, [employee.id]);
  const active = fixture({ targets: [{ ...employee, active: true }] });
  assert.equal((await active.request("delete", { userId: employee.id })).status, 400);
  assert.equal(active.authDeletes.length, 0);
});

test("failed creation removes only the new authentication account", async () => {
  const app = fixture({ profileError: true });
  assert.equal((await app.request("create", newEmployee)).status, 400);
  assert.deepEqual(app.authDeletes, ["new-user"]);
  assert.equal(app.writes[0].payload.store_id, vestano);
});

test("an authentication-update failure restores the employee in the same store", async () => {
  const app = fixture({ targets: [employee], authError: true });
  assert.equal((await app.request("update", { userId: employee.id, name: "Changed", password: "new-password" })).status, 400);
  assert.equal(app.rows.find(row => row.id === employee.id).name, employee.name);
  assert.equal(app.rows.find(row => row.id === employee.id).store_id, vestano);
  assert.equal(app.writes.length, 2);
  assert.ok(app.writes.every(write => write.filters.some(([key, value]) => key === "store_id" && value === vestano)));
});
