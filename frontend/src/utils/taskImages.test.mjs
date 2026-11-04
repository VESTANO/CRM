import assert from "node:assert/strict";
import test from "node:test";
import { addTaskImages, taskCompletionPayload, MAX_TASK_IMAGE_BYTES } from "./taskImages.js";
const image = (name = "section.png") => new File(["image"], name, { type: "image/png", lastModified: 123 });

test("multiple selections accumulate, deduplicate and respect existing photos", () => {
  const first = image(), second = image("after.png");
  assert.deepEqual(addTaskImages([first], [first, second]), [first, second]);
  assert.throws(() => addTaskImages([first], [second], 9), /up to 10/);
  assert.deepEqual(addTaskImages([], [first], 9), [first]);
});

test("rejects non-images, empty or oversized files without changing selection", () => {
  const files = [image()];
  for (const file of [new File(["<svg/>"], "script.svg", { type: "image/svg+xml" }),
    new File([], "empty.png", { type: "image/png" }),
    { name: "large.png", type: "image/png", size: MAX_TASK_IMAGE_BYTES + 1 }]) {
    assert.throws(() => addTaskImages(files, [file]));
    assert.equal(files.length, 1);
  }
});

test("deduplicates compressed selections using the source identity instead of their new size", () => {
  const original = image();
  const compressed = new File(["small"], original.name, { type: "image/webp", lastModified: original.lastModified });
  compressed.sourceKey = `${original.name}:${original.size}:${original.lastModified}`;
  assert.deepEqual(addTaskImages([compressed], [original]), [compressed]);
});

test("submission sends all files and the user note; resubmission identifies the rejected attempt", () => {
  const payload = taskCompletionPayload([image(), image("after2.png")], "  Arranged the section.  ");
  assert.equal(payload.get("status"), "submitted");
  assert.equal(payload.get("submission_note"), "Arranged the section.");
  assert.equal(payload.getAll("images").length, 2);
  assert.equal(taskCompletionPayload([image()], "Fixed the shelves.", 42).get("previous_submission_id"), "42");
  assert.deepEqual(taskCompletionPayload([], "Text task finished"), { status: "submitted", submission_note: "Text task finished" });
});

test("submission pairs every compressed image with its thumbnail in selection order", () => {
  const files = [image("one.png"), image("two.png")];
  files.forEach((file, index) => { file.thumbnail = image(`thumb${index}.webp`); });
  const payload = taskCompletionPayload(files, "  Ready  ");
  assert.deepEqual(payload.getAll("images"), files);
  assert.deepEqual(payload.getAll("image_thumbnails"), files.map((file) => file.thumbnail));
  assert.equal(payload.get("submission_note"), "Ready");
});
