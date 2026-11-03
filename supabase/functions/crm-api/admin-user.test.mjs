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
  const target = { id: "target-user", employee_id: "NEWUSER", email: "new@example.com", role: "admin", active: true };
  const run = new Function("adminClient", "requireAdmin", "valueString", "fail", "checkDb", "profileWithCounts", "json", "syncAttendanceAdmin", "adminUserById", "isAdminRole", `${handler}; return handleAdmin;`)(
    client, requireAdmin, (value) => String(value || "").trim(), fail,
    (error) => { if (error) throw error; }, async (profile) => profile,
    (status, data) => ({ status, data }),
    async (profile, exactRole) => { synced.push(profile); syncModes.push(exactRole); if (syncError) throw syncError; },
    async () => target, (role) => ["admin", "super_admin"].includes(role),
  );
  return { writes, synced, syncModes, deleted, accounts: () => accounts,
    edit: (body, ownAccount = false, callerRole = "admin") => run({ user: { id: ownAccount ? target.id : "caller" }, profile: { role: callerRole } }, "PATCH", ["admin", "users", target.id], new URLSearchParams(), body),
    create: (body, role = "admin") => run({ profile: { role } }, "POST", ["admin", "users"], new URLSearchParams(), {
    username: "NEWUSER", email: "new@example.com", password1: "password123", password2: "password123", ...body,
  }) };
}

test("selected roles survive both profile creation paths; omitted role defaults to employee", async () => {
  for (const existing of [false, true]) {
    for (const role of ["employee", "admin", "super_admin", undefined]) {
      const app = setup(existing);
      const result = await app.create(role === undefined ? {} : { role });
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
    const result = await app.edit({ role });
    assert.equal(result.data.role, role);
    assert.equal(app.synced[0].role, role);
    assert.deepEqual(app.syncModes, [true]);
  }
});

test("editing without a role preserves it without syncing; invalid roles and self-demotion are denied", async () => {
  const app = setup();
  assert.equal((await app.edit({})).data.role, "admin");
  assert.equal(app.synced.length, 0);
  for (const role of ["manager", "", null]) {
    await assert.rejects(setup().edit({ role }), { status: 400 });
  }
  await assert.rejects(setup().edit({ role: "employee" }, true), { status: 400 });
  await assert.rejects(setup().edit({ role: "admin" }, false, "employee"), { status: 403 });
});

test("failed Attendance role edit restores the CRM profile", async () => {
  const app = setup(false, new Error("Attendance unavailable"));
  await assert.rejects(app.edit({ role: "employee" }), { status: 503 });
  assert.equal(app.writes.at(-1).role, "admin");
  assert.equal(app.deleted.length, 0);
});

test("Attendance synchronization failure rolls back the newly created CRM account", async () => {
  const app = setup(false, new Error("Attendance unavailable"));
  await assert.rejects(app.create({ role: "admin" }), /Attendance unavailable/);
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

test("employees cannot create administrator accounts", async () => {
  const app = setup();
  for (const role of ["admin", "super_admin"]) {
    await assert.rejects(app.create({ role }, "employee"), { status: 403 });
  }
  assert.equal(app.accounts(), 0);
});
