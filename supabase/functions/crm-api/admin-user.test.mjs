import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise the real handler without starting the Edge Function or creating accounts.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const handler = stripTypeScriptTypes(source.slice(source.indexOf("async function handleAdmin("), source.indexOf("async function overtimeContext(")));

function setup(existingProfile = false, syncError = null) {
  const writes = [];
  const synced = [];
  const syncModes = [];
  const deleted = [];
  let accounts = 0;
  const client = {
    auth: { admin: { createUser: async () => {
      accounts++;
      return { data: { user: { id: "new-user" } } };
    }, deleteUser: async (id) => { deleted.push(id); return {}; } } },
    from: () => {
      let payload;
      let filter;
      const query = {
        select: () => query,
        or: () => { filter = "duplicate"; return query; },
        eq: () => query,
        neq: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: filter === "duplicate" || !existingProfile ? null : { id: "new-user" } }),
        insert: (value) => { payload = value; writes.push(value); return query; },
        update: (value) => { payload = value; writes.push(value); return query; },
        single: async () => ({ data: { id: "new-user", ...payload } }),
      };
      return query;
    },
  };
  const fail = (status, message, payload) => { throw Object.assign(new Error(message), { status, payload }); };
  const requireAdmin = (ctx) => { if (!["admin", "super_admin"].includes(ctx.profile.role)) fail(403, "Administrator access required."); };
  const target = { id: "target-user", employee_id: "NEWUSER", email: "new@example.com", role: "admin", active: true, designation: "Existing designation" };
  const run = new Function("adminClient", "requireAdmin", "requireStoreContext", "valueString", "fail", "checkDb", "profileWithCounts", "json", "syncAttendanceAdmin", "adminUserById", "isAdminRole", "isSuperAdmin", "enforceStoreAccountLimit", "userPayload", `${handler}; return handleAdmin;`)(
    client, requireAdmin, (ctx) => ctx.profile.store_id, (value) => String(value || "").trim(), fail,
    (error) => { if (error) throw error; }, async (profile) => profile,
    (status, data) => ({ status, data }),
    async (profile, exactRole) => { synced.push(profile); syncModes.push(exactRole); if (syncError) throw syncError; },
    async () => target, (role) => ["admin", "super_admin"].includes(role),
    (ctx) => ctx.profile.role === "super_admin",
    async () => {},
    (profile, extras = {}) => ({ ...profile, ...extras }),
  );
  return { writes, synced, syncModes, deleted, accounts: () => accounts,
    edit: (body, ownAccount = false, callerRole = "admin") => run({ user: { id: ownAccount ? target.id : "caller" }, profile: { role: callerRole } }, "PATCH", ["admin", "users", target.id], new URLSearchParams(), body),
    create: (body, role = "admin") => run({ profile: { role, store_id: "store-1" } }, "POST", ["admin", "users"], new URLSearchParams(), {
    username: "NEWUSER", email: "new@example.com", designation: "Existing designation", password1: "password123", password2: "password123", store_id: "store-1", ...body,
  }),
    createDesignation: (name, role = "admin", requestedStore = "") => run(
      { user: { id: "caller" }, profile: { role, store_id: "store-1" } },
      "POST", ["admin", "designations"], new URLSearchParams(requestedStore ? { store: requestedStore } : {}), { name },
    ),
  };
}

test("selected roles survive both profile creation paths; omitted role defaults to employee", async () => {
  for (const existing of [false, true]) {
    for (const role of ["employee", "admin", "super_admin", undefined]) {
      const app = setup(existing);
      const result = await app.create(role === undefined ? {} : { role }, ["admin", "super_admin"].includes(role) ? "super_admin" : "admin");
      assert.equal(result.status, 201);
      assert.equal(result.data.role, role ?? "employee");
      assert.equal(app.writes[0].role, role ?? "employee");
      assert.equal(app.synced[0].role, role ?? "employee");
    }
  }
});

test("editing a role saves the selection and synchronizes the exact Attendance role", async () => {
  for (const role of ["employee", "super_admin"]) {
    const app = setup();
    const result = await app.edit({ role }, false, "super_admin");
    assert.equal(result.data.role, role);
    assert.equal(app.synced[0].role, role);
    assert.deepEqual(app.syncModes, [true]);
  }
});

test("editing without a role preserves it without syncing; invalid roles and self-demotion are denied", async () => {
  const app = setup();
  assert.equal((await app.edit({}, false, "super_admin")).data.role, "admin");
  assert.equal(app.synced.length, 0);
  for (const role of ["manager", "", null]) {
    await assert.rejects(setup().edit({ role }, false, "super_admin"), { status: 400 });
  }
  await assert.rejects(setup().edit({ role: "employee" }, true, "super_admin"), { status: 400 });
  await assert.rejects(setup().edit({ role: "admin" }, false, "employee"), { status: 403 });
});

test("failed Attendance role edit restores the CRM profile", async () => {
  const app = setup(false, new Error("Attendance unavailable"));
  await assert.rejects(app.edit({ role: "employee" }, false, "super_admin"), { status: 503 });
  assert.equal(app.writes.at(-1).role, "admin");
  assert.equal(app.deleted.length, 0);
});

test("Attendance synchronization failure rolls back the newly created CRM account", async () => {
  const app = setup(false, new Error("Attendance unavailable"));
  await assert.rejects(app.create({ role: "admin" }, "super_admin"), /Attendance unavailable/);
  assert.deepEqual(app.deleted, ["new-user"]);
});

test("invalid roles are rejected before creating an authentication account", async () => {
  for (const role of ["manager", "", null, {}, "ADMIN"]) {
    const app = setup();
    await assert.rejects(app.create({ role }), (error) => error.status === 400 && Boolean(error.payload.errors.role));
    assert.equal(app.accounts(), 0);
    assert.equal(app.writes.length, 0);
  }
});

test("only Super Admins can create or manage administrator accounts", async () => {
  const app = setup();
  for (const role of ["admin", "super_admin"]) {
    await assert.rejects(app.create({ role }, "admin"), { status: 400 });
    await assert.rejects(app.create({ role }, "employee"), { status: 403 });
  }
  await assert.rejects(app.edit({ role: "employee" }, false, "admin"), { status: 403 });
  assert.equal(app.accounts(), 0);
});

test("designations are stored with users, cleared for admins, and managed in the administrator's store", async () => {
  const created = setup();
  const createResult = await created.create({ designation: "Sales Executive" });
  assert.equal(createResult.data.designation, "Sales Executive");
  assert.equal(created.writes[0].designation, "Sales Executive");

  const edited = setup();
  const editResult = await edited.edit({ designation: "Team Lead" }, false, "super_admin");
  assert.equal(editResult.data.designation, "");
  assert.equal(edited.writes.at(-1).designation, "");

  const options = setup();
  const adminResult = await options.createDesignation("Field Executive");
  assert.equal(adminResult.status, 201);
  assert.equal(options.writes.at(-1).store_id, "store-1");
  const superAdminResult = await options.createDesignation("Regional Manager", "super_admin", "store-2");
  assert.equal(superAdminResult.status, 201);
  assert.equal(options.writes.at(-1).store_id, "store-2");
  await assert.rejects(options.createDesignation("   "), { status: 400 });
});

test("only regular store users require a designation", async () => {
  await assert.rejects(setup().create({ designation: "" }), (error) => error.status === 400 && Boolean(error.payload.errors.designation));
  const app = setup();
  await assert.rejects(app.edit({ role: "employee", designation: "" }, false, "super_admin"), (error) => error.status === 400 && Boolean(error.payload.errors.designation));
  assert.equal((await setup().create({ role: "admin", designation: "" }, "super_admin")).status, 201);
  assert.equal((await setup().create({ role: "super_admin", designation: "" }, "super_admin")).status, 201);
});
