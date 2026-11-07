import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const handler = stripTypeScriptTypes(source.slice(source.indexOf("async function handleAdmin("), source.indexOf("async function overtimeContext(")));
const validStore = {
  name: "  Kochi Store  ", contact_person: "  Store Manager  ",
  contact_email: "  MANAGER@example.test  ", contact_phone: "+91 9876543210",
  address_line1: "  1 Test Road  ", city: "  Kochi  ",
  state: "Kerala", postal_code: "682001",
};

function setup() {
  const writes = [];
  const client = { from: (table) => {
    assert.equal(table, "crm_stores");
    const query = {
      insert: (payload) => { writes.push(payload); return query; },
      select: () => query,
      single: async () => ({ data: { id: "new-store", ...writes.at(-1) }, error: null }),
    };
    return query;
  } };
  const fail = (status, message, payload) => { throw Object.assign(new Error(message), { status, payload }); };
  const handle = new Function("adminClient", "requireAdmin", "requireSuperAdmin", "valueString", "fail", "checkDb", "json", `${handler}; return handleAdmin;`)(
    client,
    (ctx) => { if (!["admin", "super_admin"].includes(ctx.profile.role)) fail(403, "Administrator access required."); },
    (ctx) => { if (ctx.profile.role !== "super_admin") fail(403, "Super Admin access required."); },
    (value) => String(value ?? "").trim(), fail,
    (error) => { if (error) throw error; },
    (status, data) => ({ status, data }),
  );
  return { writes, create: (body, role = "super_admin") => handle({ user: { id: "creator" }, profile: { role } }, "POST", ["admin", "stores"], new URLSearchParams(), body) };
}

test("Super Admin store creation saves all contact and address fields", async () => {
  const app = setup();
  const result = await app.create(validStore);
  assert.equal(result.status, 201);
  assert.deepEqual(app.writes, [{
    name: "Kochi Store", contact_person: "Store Manager", contact_email: "manager@example.test",
    contact_phone: "+91 9876543210", address_line1: "1 Test Road",
    city: "Kochi", state: "Kerala", postal_code: "682001", created_by: "creator",
  }]);
});

test("incomplete or invalid store details are rejected before a database write", async () => {
  const app = setup();
  await assert.rejects(app.create({ name: "Only a name" }), { status: 400 });
  await assert.rejects(app.create({ ...validStore, contact_email: "invalid" }), { status: 400 });
  await assert.rejects(app.create({ ...validStore, contact_phone: "123" }), { status: 400 });
  assert.equal(app.writes.length, 0);
});

test("store Admin cannot create a store with a direct API request", async () => {
  const app = setup();
  await assert.rejects(app.create(validStore, "admin"), { status: 403 });
  assert.equal(app.writes.length, 0);
});
