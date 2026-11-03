import { ensureAttendanceAdmin } from "./attendance-admin.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const crm = { employee_id: "ADMIN_01", email: "admin@example.com", name: "CRM Admin", role: "admin", active: true };
const existing = { id: "attendance-1", employee_id: "ADMIN_01", email: "other@example.com", name: "Original name", role: "employee", active: true };

function setup(profiles: any[] = [], options: { emailMatch?: boolean; profileError?: boolean; createError?: boolean } = {}) {
  const writes: any[] = [], created: any[] = [], deleted: string[] = [], filters: any[] = [];
  const client = {
    auth: { admin: {
      createUser: (body: any) => { created.push(body); return Promise.resolve(options.createError ? { error: new Error("Auth unavailable") } : { data: { user: { id: "new-attendance" } } }); },
      deleteUser: (id: string) => { deleted.push(id); return Promise.resolve({}); },
    } },
    from: () => {
      let payload: any;
      const query: any = {
        select: () => query,
        ilike: (field: string, value: string) => { filters.push([field, value]); return query; },
        limit: () => Promise.resolve({ data: filters.at(-1)[0] === "email" ? (options.emailMatch ? [{ id: "other-user" }] : []) : profiles }),
        update: (body: any) => { payload = body; writes.push(body); return query; },
        upsert: (body: any) => { payload = body; writes.push(body); return query; },
        eq: () => query,
        single: () => Promise.resolve(options.profileError ? { error: new Error("Profile unavailable") } : { data: { ...profiles[0], ...payload } }),
      };
      return query;
    },
  };
  return { client, writes, created, deleted, filters };
}

Deno.test("CRM admin upgrades only the role of its matching Attendance employee", async () => {
  const app = setup([existing]);
  const result = await ensureAttendanceAdmin(app.client, crm);
  equal(app.writes, [{ role: "admin" }]);
  equal(result.name, "Original name");
  equal(result.email, "other@example.com");
  equal(app.created.length, 0);
  equal(app.filters[0], ["employee_id", "ADMIN\\_01"]);
});

Deno.test("missing admin and super admin accounts are provisioned with corresponding roles", async () => {
  for (const role of ["admin", "super_admin"]) {
    const app = setup();
    const result = await ensureAttendanceAdmin(app.client, { ...crm, role });
    equal(result.role, role);
    equal(result.employee_id, crm.employee_id);
    equal(app.created.length, 1);
    equal(app.created[0].email, crm.email);
    equal(new TextEncoder().encode(app.created[0].password).length <= 72, true);
    equal(app.deleted, []);
  }
});

Deno.test("employee login never provisions or promotes Attendance access", async () => {
  const app = setup([existing]);
  equal(await ensureAttendanceAdmin(app.client, { ...crm, role: "employee" }), null);
  equal(app.filters, []);
  equal(app.writes, []);
  equal(app.created, []);
});

Deno.test("Attendance super admin is preserved; CRM super admin upgrades an admin", async () => {
  const app = setup([{ ...existing, role: "super_admin" }]);
  await ensureAttendanceAdmin(app.client, crm);
  equal(app.writes, []);
  const promoted = setup([{ ...existing, role: "admin" }]);
  await ensureAttendanceAdmin(promoted.client, { ...crm, role: "super_admin" });
  equal(promoted.writes, [{ role: "super_admin" }]);
});

Deno.test("inactive, duplicate, and conflicting-email accounts are denied without writes", async () => {
  for (const app of [setup([{ ...existing, active: false }]), setup([existing, existing]), setup([], { emailMatch: true })]) {
    let rejected = false;
    try { await ensureAttendanceAdmin(app.client, crm); } catch { rejected = true; }
    equal(rejected, true);
    equal(app.writes, []);
    equal(app.created, []);
  }
});

Deno.test("failed Attendance profile provisioning removes its new authentication account", async () => {
  const app = setup([], { profileError: true });
  let rejected = false;
  try { await ensureAttendanceAdmin(app.client, crm); } catch { rejected = true; }
  equal(rejected, true);
  equal(app.deleted, ["new-attendance"]);
});

Deno.test("an explicit CRM role edit also demotes Attendance, preserving its other fields", async () => {
  for (const role of ["employee", "admin"]) {
    const app = setup([{ ...existing, role: "super_admin" }]);
    const result = await ensureAttendanceAdmin(app.client, { ...crm, role }, true);
    equal(app.writes, [{ role }]);
    equal(result.name, existing.name);
  }
  const missing = setup();
  await ensureAttendanceAdmin(missing.client, { ...crm, role: "employee" }, true);
  equal(missing.created, []);
});
