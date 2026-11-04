import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskImages, saveTaskPhotos, signedTaskImages, reviewTaskSubmission, uploadPhotoObjects } from "./task-images.ts";
import { PHOTO_MAX_BYTES, THUMBNAIL_MAX_BYTES } from "./photo-metadata.js";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const png = (name = "section.png") => new File([pngBytes], name, { type: "image/png" });
// Keep valid PNG header bytes while varying the metadata the API checks.
const sizedPng = (width, height, size = pngBytes.length) => {
  const bytes = Buffer.alloc(size); pngBytes.copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return new File([bytes], "section.png", { type: "image/png" });
};
const fullPhoto = () => sizedPng(1280, 720, 24 * 1024);
const thumbnail = () => sizedPng(256, 144);

test("validates every image before uploading, rejecting unsafe formats, signatures, size and count", async () => {
  await validateTaskImages([png(), png("before.png")]);
  const bad = [
    new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
    new File(["this is not a photo"], "image.png", { type: "image/png" }),
    new File([], "empty.png", { type: "image/png" }),
    new File([new Uint8Array(PHOTO_MAX_BYTES + 1)], "huge.png", { type: "image/png" }),
    new File([Uint8Array.from([255,216,255,0])], "broken.jpg", { type: "image/jpeg" }),
    new File([pngBytes], "mime.jpg", { type: "image/jpeg" }),
    sizedPng(1281, 720),
  ];
  for (const file of bad) await assert.rejects(validateTaskImages([file]), { status: 400 });
  await assert.rejects(validateTaskImages(Array.from({ length: 11 }, () => png())), /up to 10/);
});

test("requires correctly paired, bounded thumbnails for larger popup images", async () => {
  const [meta] = await validateTaskImages([fullPhoto()], [thumbnail()]);
  assert.deepEqual(meta, { width: 1280, height: 720, byte_size: 24576, thumbnail_byte_size: pngBytes.length });
  await assert.rejects(validateTaskImages([fullPhoto()]), /generate small thumbnails/);
  await assert.rejects(validateTaskImages([fullPhoto()], [thumbnail(), thumbnail()]), /matching thumbnail/);
  await assert.rejects(validateTaskImages([], [thumbnail()]), /matching thumbnail/);
  await assert.rejects(validateTaskImages([fullPhoto()], [sizedPng(257, 145)]), /resized and compressed/);
  await assert.rejects(validateTaskImages([fullPhoto()], [sizedPng(256, 144, THUMBNAIL_MAX_BYTES + 1)]), /too large/);
  await assert.rejects(validateTaskImages([fullPhoto()], [sizedPng(256, 256)]), /do not match/);
  // Integer rounding by the browser is allowed for very wide photos.
  await validateTaskImages([sizedPng(1280, 61)], [sizedPng(256, 12)]);
});

function setup({ failUpload = 0, rpcError = null } = {}) {
  const uploads = [], removals = [], commits = [];
  const client = {
    storage: { from: (bucket) => {
      assert.equal(bucket, "crm-task-images");
      return {
        upload: async (path, file, options) => {
          uploads.push({ path, file, options });
          return { error: uploads.length === failUpload ? { message: "upload failed" } : null };
        },
        remove: async (paths) => { removals.push(paths); return { error: null }; },
      };
    } },
    rpc: async (name, args) => { commits.push({ name, args }); return { data: { id: 12, status: args.p_values.status }, error: rpcError }; },
  };
  return { client, uploads, removals, commits };
}

test("commits both images in one RPC, deriving uploader/stage from trusted arguments", async () => {
  const app = setup();
  const saved = await saveTaskPhotos(app.client, "actor", 12, "completion", { status: "done" }, [png(), png("second.png")]);
  assert.equal(saved.status, "done");
  assert.equal(app.commits.length, 1);
  assert.equal(app.commits[0].name, "crm_save_task_photos");
  assert.equal(app.commits[0].args.p_stage, "completion");
  assert.equal(app.commits[0].args.p_actor, "actor");
  assert.equal(app.commits[0].args.p_images.length, 2);
  assert.match(app.uploads[0].path, /^actor\/[a-f0-9-]+\.png$/);
  assert.notEqual(app.uploads[0].path, app.uploads[1].path);
  assert.equal(app.removals.length, 0);
});

test("partial upload failure cleans up saved objects and never completes the task", async () => {
  const app = setup({ failUpload: 2 });
  await assert.rejects(saveTaskPhotos(app.client, "actor", 12, "completion", { status: "done" }, [png(), png()]), { status: 502 });
  assert.equal(app.commits.length, 0);
  assert.deepEqual(app.removals, [[app.uploads[0].path]]);
});

test("uploads full and thumbnail objects together and commits their metadata", async () => {
  const app = setup();
  await saveTaskPhotos(app.client, "actor", 12, "completion", { status: "submitted" }, [fullPhoto()], [thumbnail()]);
  assert.equal(app.uploads.length, 2);
  assert.match(app.uploads[1].path, /\.thumb\.png$/);
  assert.equal(app.uploads[0].options.cacheControl, "31536000");
  assert.equal(app.uploads[0].options.upsert, false);
  const [photo] = app.commits[0].args.p_images;
  assert.equal(photo.storage_path, app.uploads[0].path);
  assert.equal(photo.thumbnail_path, app.uploads[1].path);
  assert.equal(photo.byte_size, 24576);
  assert.equal(photo.thumbnail_byte_size, pngBytes.length);
  assert.equal(photo.width, 1280);
  assert.equal(photo.height, 720);
});

test("thumbnail upload failure removes the full photo and never commits metadata", async () => {
  const app = setup({ failUpload: 2 });
  await assert.rejects(saveTaskPhotos(app.client, "actor", 12, "completion", {}, [fullPhoto()], [thumbnail()]), /Thumbnail upload failed/);
  assert.deepEqual(app.removals, [[app.uploads[0].path]]);
  assert.equal(app.commits.length, 0);
});

test("transaction failure removes both variants", async () => {
  const app = setup({ rpcError: { code: "42501", message: "Forbidden" } });
  await assert.rejects(saveTaskPhotos(app.client, "actor", 12, "completion", {}, [fullPhoto()], [thumbnail()]), { status: 403 });
  assert.deepEqual(app.removals, [app.uploads.map((photo) => photo.path)]);
});

test("generic uploader supports the visit image bucket and trusted path prefix", async () => {
  const uploaded = [];
  const client = { storage: { from: (bucket) => {
    assert.equal(bucket, "crm-visit-images");
    return { upload: async (path) => { uploaded.push(path); return { error: null }; } };
  } } };
  const result = await uploadPhotoObjects(client, "crm-visit-images", "visit-42", [fullPhoto()], [thumbnail()]);
  assert.equal(result.paths.length, 2);
  assert.match(result.paths[0], /^visit-42\//);
  assert.deepEqual(result.paths, uploaded);
});

test("a failed transaction cleans up every upload and preserves an access error", async () => {
  const app = setup({ rpcError: { code: "P0002", message: "Task not found." } });
  await assert.rejects(saveTaskPhotos(app.client, "other-user", 12, "completion", {}, [png(), png()]), { status: 404 });
  assert.deepEqual(app.removals[0], app.uploads.map((item) => item.path));
});

test("invalid images do not create any objects or tasks", async () => {
  const app = setup();
  await assert.rejects(saveTaskPhotos(app.client, "admin", null, "assignment", { title: "Arrange" }, [png(), new File(["fake"], "fake.png", { type: "image/png" })]));
  assert.equal(app.uploads.length, 0);
  assert.equal(app.commits.length, 0);
});

test("reviews pass the trusted reviewer, exact submission and rejection note to one transaction", async () => {
  let call;
  const client = { rpc: async (name, args) => { call = { name, args }; return { data: { id: 12, status: "rejected" }, error: null }; } };
  const saved = await reviewTaskSubmission(client, "admin", 12, 32, "reject", "Arrange the top shelf again.");
  assert.equal(saved.status, "rejected");
  assert.deepEqual(call, { name: "crm_review_task_submission", args: { p_task_id: 12, p_submission_id: 32, p_actor: "admin", p_action: "reject", p_note: "Arrange the top shelf again." } });
});

test("stale or duplicate submissions clean uploaded files and return a conflict", async () => {
  const app = setup({ rpcError: { code: "P0001", message: "Already submitted" } });
  await assert.rejects(saveTaskPhotos(app.client, "actor", 12, "completion", { status: "submitted" }, [png()]), { status: 409 });
  assert.deepEqual(app.removals[0], app.uploads.map((item) => item.path));
  await assert.rejects(reviewTaskSubmission({ rpc: async () => ({ error: { code: "P0001", message: "Already reviewed" } }) }, "admin", 12, 32, "approve", ""), { status: 409 });
});

test("signed URLs are generated in bulk and stay stable between feed polls", async () => {
  let calls = 0;
  const client = { storage: { from: () => ({ createSignedUrls: async (paths, expiry) => {
    calls++;
    assert.equal(expiry, 3600);
    return { data: paths.map((path) => ({ path, signedUrl: `https://test.invalid/${path}` })), error: null };
  } }) } };
  const rows = [1, 2].map((id) => ({ id, task_id: 12, stage: "assignment", storage_path: `sign-test/${id}`, original_name: `${id}.png` }));
  const first = await signedTaskImages(client, rows);
  assert.equal(first.length, 2);
  assert.equal(calls, 1);
  assert.deepEqual(await signedTaskImages(client, rows), first);
  assert.equal(calls, 1);
  assert.equal(first[0].storage_path, undefined);
});

test("signs small thumbnails separately, falls back for legacy photos and scopes the cache by bucket", async () => {
  const calls = [];
  const client = { storage: { from: (bucket) => ({ createSignedUrls: async (paths) => {
    calls.push({ bucket, paths });
    return { data: paths.map((path) => ({ path, signedUrl: `https://test.invalid/${bucket}/${path}` })), error: null };
  } }) } };
  const rows = [{ id: 3, storage_path: "variant-test/full.webp", thumbnail_path: "variant-test/thumb.webp", byte_size: 12000, thumbnail_byte_size: 1000, width: 1280, height: 720 },
    { id: 4, storage_path: "variant-test/legacy.png" }];
  const first = await signedTaskImages(client, rows);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].paths, [rows[0].storage_path, rows[0].thumbnail_path, rows[1].storage_path]);
  assert.equal(first[0].thumbnail_url, "https://test.invalid/crm-task-images/variant-test/thumb.webp");
  assert.equal(first[1].thumbnail_url, first[1].url);
  assert.equal(first[0].byte_size, 12000);
  assert.equal(first[0].thumbnail_path, undefined);
  await signedTaskImages(client, rows);
  assert.equal(calls.length, 1);
  const visit = await signedTaskImages(client, rows, "crm-visit-images");
  assert.equal(calls.length, 2);
  assert.notEqual(visit[0].url, first[0].url);
});

test("signing a large gallery splits requests into bounded batches", async () => {
  const calls = [];
  const client = { storage: { from: () => ({ createSignedUrls: async (paths) => {
    calls.push(paths.length);
    return { data: paths.map((path) => ({ path, signedUrl: `https://test.invalid/${path}` })), error: null };
  } }) } };
  const rows = Array.from({ length: 101 }, (_, id) => ({ id, storage_path: `batch-test/${id}.webp`, thumbnail_path: `batch-test/${id}.thumb.webp` }));
  const result = await signedTaskImages(client, rows);
  assert.deepEqual(calls, [200, 2]);
  assert.ok(result.every((photo) => photo.url && photo.thumbnail_url));
});
