import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const handler = stripTypeScriptTypes(source.slice(source.indexOf("async function createOrUpdateVisit("), source.indexOf("async function visibleVisit(")));
const ctx = { user: { id: "owner" }, profile: { role: "employee", store_id: "store-a" } };

function setup() {
  const writes = [];
  const client = { rpc: async (name, values) => { writes.push({ table: name, values }); return { data: { id: 22, ...values.p_values } }; }, from: (table) => {
    let payload;
    const query = {
      select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: { id: 11 } }),
      single: async () => ({ data: { id: 22, ...payload } }),
      insert: (values) => { payload = values; writes.push({ table, values }); return query; },
      update: (values) => { payload = values; writes.push({ table, values }); return query; },
    };
    return query;
  } };
  const fail = (status, message, payload) => { throw Object.assign(new Error(message), { status, ...payload }); };
  const run = new Function("valueString", "fail", "visibleVisit", "adminClient", "checkDb", "accessibleDataset", "parseId", "uploadVisitImages", "serializeVisit", "requireStoreContext", `${handler}; return createOrUpdateVisit;`)(
    (value) => String(value ?? "").trim(), fail,
    async () => ({ id: 22, owner_id: "owner", manual_client_id: 11, meeting_time: "10:00:00", location: "Office" }),
    client, (error) => { if (error) throw error; }, async () => ({ id: 1, owner_id: "owner" }), Number,
    async () => {}, async (visit) => visit, ctx => ctx.profile.store_id,
  );
  return { writes, run };
}

test("manual and existing-client visits accept omitted or blank meeting fields", async () => {
  for (const visit_mode of ["manual", "existing"]) {
    for (const fields of [{}, { meeting_time: "", location: "" }]) {
      const app = setup();
      const saved = await app.run(ctx, null, { visit_mode, client_name: "Client", dataset: 1, customer: 11, visit_date: "2026-11-03", ...fields }, []);
      assert.equal(saved.meeting_time, null);
      assert.equal(saved.location, "");
    }
  }
});

test("editing a visit clears existing time and location", async () => {
  const app = setup();
  const saved = await app.run(ctx, 22, { visit_mode: "manual", client_name: "Client", visit_date: "2026-11-03", meeting_time: "", location: "" }, []);
  assert.equal(saved.meeting_time, null);
  assert.equal(saved.location, "");
});

test("supplied meeting values are retained and invalid times or long locations are rejected before writes", async () => {
  const payload = { visit_mode: "manual", client_name: "Client", visit_date: "2026-11-03", meeting_time: "10:30", location: "Office" };
  const saved = await setup().run(ctx, null, payload, []);
  assert.equal(saved.meeting_time, "10:30:00");
  assert.equal(saved.location, "Office");
  for (const fields of [{ meeting_time: "25:00" }, { meeting_time: "12:70" }, { meeting_time: "invalid" }, { location: "x".repeat(256) }]) {
    const app = setup();
    await assert.rejects(app.run(ctx, null, { ...payload, ...fields }, []), (error) => error.status === 400);
    assert.equal(app.writes.length, 0);
  }
});
