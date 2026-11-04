import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const handler = stripTypeScriptTypes(source.slice(source.indexOf("async function requestBody("), source.indexOf("async function visibleRecords(")));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const requestBody = new Function("fail", `${handler}; return requestBody;`)(fail);
const maximum = 3 * 1024 * 1024;
const root = "https://example.test/functions/v1/crm-api/api";

test("photo multipart keeps full images and thumbnails in matching selection order", async () => {
  const form = new FormData();
  form.append("title", "Arrange shelves");
  form.append("submission_note", "Arranged and checked");
  form.append("images", new File(["first-full"], "before-one.webp", { type: "image/webp" }));
  form.append("images", new File(["second-full"], "before-two.webp", { type: "image/webp" }));
  form.append("image_thumbnails", new File(["first-thumb"], "one.thumb.webp", { type: "image/webp" }));
  form.append("image_thumbnails", new File(["second-thumb"], "two.thumb.webp", { type: "image/webp" }));
  form.append("images", ""); // Empty browser controls must not become task values.
  form.append("images", new File([], ""));
  const parsed = await requestBody(new Request(`${root}/admin/tasks/`, { method: "POST", body: form }));
  assert.deepEqual(parsed.values, { title: "Arrange shelves", submission_note: "Arranged and checked" });
  assert.deepEqual(parsed.files.map((file) => file.name), ["before-one.webp", "before-two.webp"]);
  assert.deepEqual(parsed.thumbnails.map((file) => file.name), ["one.thumb.webp", "two.thumb.webp"]);
  assert.deepEqual(await Promise.all(parsed.files.map((file) => file.text())), ["first-full", "second-full"]);
  assert.deepEqual(await Promise.all(parsed.thumbnails.map((file) => file.text())), ["first-thumb", "second-thumb"]);
});

test("every task and visit photo route drains an oversized declared body before rejecting without parsing", async () => {
  for (const path of ["/admin/tasks/", "/admin/tasks/17", "/tasks/17/", "/sales/visits/", "/sales/visits/91/?preview=true"]) {
    const request = new Request(`${root}${path}`, {
      method: "PATCH", body: "unparsed", headers: { "content-type": "multipart/form-data; boundary=test", "content-length": String(maximum + 1) },
    });
    await assert.rejects(requestBody(request), (error) => error.status === 413 && /compress/i.test(error.message), path);
    assert.equal(request.bodyUsed, true, path);
    assert.equal(request.body.locked, false, path);
  }
});

test("a photo stream without content length is bounded and released without transport cancellation", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)); controller.close(); },
    cancel() { cancelled = true; },
  });
  const request = new Request(`${root}/tasks/17/`, {
    method: "PATCH", duplex: "half", body: stream, headers: { "content-type": "multipart/form-data; boundary=test" },
  });
  await assert.rejects(requestBody(request), (error) => error.status === 413 && /too large/i.test(error.message));
  assert.equal(cancelled, false);
  assert.equal(request.body.locked, false);
});

test("a misleading small content length cannot bypass the streaming photo limit", async () => {
  const request = new Request(`${root}/sales/visits/91/`, {
    method: "POST", body: new Uint8Array(maximum + 1),
    headers: { "content-type": "multipart/form-data; boundary=test", "content-length": "10" },
  });
  await assert.rejects(requestBody(request), (error) => error.status === 413);
  assert.equal(request.body.locked, false);
});

test("oversized photo rejection releases its lock without invoking transport cancellation", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(maximum + 1)); controller.close(); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  const request = new Request(`${root}/tasks/17/`, {
    method: "PATCH", duplex: "half", body: stream, headers: { "content-type": "multipart/form-data; boundary=test" },
  });
  let timeout;
  try {
    const bounded = Promise.race([
      requestBody(request),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Photo rejection waited for stream cancellation")), 100); }),
    ]);
    await assert.rejects(bounded, (error) => error.status === 413);
    assert.equal(cancelled, false);
    assert.equal(request.body.locked, false);
  } finally { clearTimeout(timeout); }
});

test("an oversized photo stream is drained to EOF and never reaches multipart parsing", async () => {
  let chunksRead = 0, cancelled = false, parserCalls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunksRead === 8) { controller.close(); return; }
      chunksRead++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request(`${root}/admin/tasks/`, {
    method: "POST", duplex: "half", body: stream, headers: { "content-type": "multipart/form-data; boundary=test" },
  });
  class ParsingGuard extends Response {
    constructor(...args) { parserCalls++; super(...args); }
  }
  const guarded = new Function("fail", "Response", `${handler}; return requestBody;`)(fail, ParsingGuard);
  await assert.rejects(guarded(request), (error) => error.status === 413);
  assert.equal(chunksRead, 8);
  assert.equal(parserCalls, 0);
  assert.equal(cancelled, false);
  assert.equal(request.body.locked, false);
  assert.equal(request.bodyUsed, true);
});

test("large dataset spreadsheet imports retain their existing multipart behavior", async () => {
  const form = new FormData();
  form.append("name", "November leads");
  form.append("file", new File([new Uint8Array(maximum + 1)], "leads.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const parsed = await requestBody(new Request(`${root}/datasets/import/`, { method: "POST", body: form }));
  assert.deepEqual(parsed.values, { name: "November leads" });
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].size, maximum + 1);
  assert.equal(parsed.files[0].name, "leads.xlsx");
  assert.deepEqual(parsed.thumbnails, []);
});

test("JSON task reviews, bodyless requests and unsupported body types still parse as before", async () => {
  assert.deepEqual(await requestBody(new Request(`${root}/admin/tasks/17/`, {
    method: "PATCH", body: JSON.stringify({ action: "reject", review_note: "Arrange the lower shelf again" }), headers: { "content-type": "application/json" },
  })), { values: { action: "reject", review_note: "Arrange the lower shelf again" }, files: [], thumbnails: [] });
  for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
    assert.deepEqual(await requestBody(new Request(`${root}/tasks/`, { method })), { values: {}, files: [], thumbnails: [] });
  }
  assert.deepEqual(await requestBody(new Request(`${root}/tasks/17/`, { method: "PATCH", body: "text" })), { values: {}, files: [], thumbnails: [] });
});
