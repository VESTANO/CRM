import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const handler = stripTypeScriptTypes(source.slice(source.indexOf("async function handleAdmin("), source.indexOf("async function overtimeContext(")));
const featureCode = stripTypeScriptTypes(source.slice(source.indexOf("const defaultStoreFeatures ="), source.indexOf("function json(")));
const { defaultStoreFeatures, validateStoreFeatures } = new Function("fail", `${featureCode}; return { defaultStoreFeatures, validateStoreFeatures };`)((status, message, payload) => { throw Object.assign(new Error(message), { status, payload }); });
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
      update: (payload) => { writes.push(payload); return query; },
      eq: () => query,
      maybeSingle: async () => ({ data: { id: "existing-store", ...writes.at(-1) }, error: null }),
      select: () => query,
      single: async () => ({ data: { id: "new-store", ...writes.at(-1) }, error: null }),
    };
    return query;
  } };
  const fail = (status, message, payload) => { throw Object.assign(new Error(message), { status, payload }); };
  const handle = new Function("adminClient", "requireAdmin", "requireSuperAdmin", "valueString", "fail", "checkDb", "json", "validateStoreFeatures", "defaultStoreFeatures", `${handler}; return handleAdmin;`)(
    client,
    (ctx) => { if (!["admin", "super_admin"].includes(ctx.profile.role)) fail(403, "Administrator access required."); },
    (ctx) => { if (ctx.profile.role !== "super_admin") fail(403, "Super Admin access required."); },
    (value) => String(value ?? "").trim(), fail,
    (error) => { if (error) throw error; },
    (status, data) => ({ status, data }), validateStoreFeatures, defaultStoreFeatures,
  );
  return { writes,
    create: (body, role = "super_admin") => handle({ user: { id: "creator" }, profile: { role } }, "POST", ["admin", "stores"], new URLSearchParams(), body),
    updateFeatures: (features, role = "super_admin") => handle({ user: { id: "creator" }, profile: { role } }, "PATCH", ["admin", "stores", "existing-store", "features"], new URLSearchParams(), { features }),
  };
}

test("Super Admin store creation saves all contact and address fields", async () => {
  const app = setup();
  const result = await app.create(validStore);
  assert.equal(result.status, 201);
  assert.deepEqual(app.writes, [{
    name: "Kochi Store", contact_person: "Store Manager", contact_email: "manager@example.test",
    contact_phone: "+91 9876543210", address_line1: "1 Test Road",
    city: "Kochi", state: "Kerala", postal_code: "682001", features: defaultStoreFeatures, created_by: "creator",
  }]);
});

test("store creation persists selected access switches", async () => {
  const app = setup();
  await app.create({ ...validStore, features: { ...defaultStoreFeatures, attendance: false, sales: false } });
  assert.equal(app.writes[0].features.attendance, false);
  assert.equal(app.writes[0].features.sales, false);
});

test("Super Admin can change store access but Admin cannot", async () => {
  const app = setup();
  const features = { ...defaultStoreFeatures, attendance: false };
  const result = await app.updateFeatures(features);
  assert.equal(result.status, 200);
  assert.deepEqual(app.writes.at(-1), { features });
  await assert.rejects(app.updateFeatures(features, "admin"), { status: 403 });
  await assert.rejects(app.updateFeatures({ sales: "false" }), { status: 400 });
  assert.equal(app.writes.length, 1);
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
