export const MAX_TASK_IMAGES = 10;
import { appendPhotoUploads, PHOTO_MAX_SOURCE_BYTES, photoSourceKey } from "./photoCompression.js";
export const MAX_TASK_IMAGE_BYTES = PHOTO_MAX_SOURCE_BYTES;
export const TASK_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/avif"];

export function addTaskImages(current, incoming, existingCount = 0) {
  const next = [...current];
  for (const file of incoming) {
    if (!TASK_IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name}: choose a JPG, PNG, GIF, WEBP, BMP or AVIF image.`);
    if (!file.size || file.size > MAX_TASK_IMAGE_BYTES) throw new Error(`${file.name}: choose an original photo up to 100 MB.`);
    if (!next.some((other) => photoSourceKey(other) === photoSourceKey(file))) next.push(file);
  }
  if (next.length + existingCount > MAX_TASK_IMAGES) throw new Error("Upload up to 10 photos per stage. Remove a photo to add another.");
  return next;
}

export function taskCompletionPayload(files, note = "", previousSubmissionId = null) {
  const values = { status: "submitted", submission_note: note.trim() };
  if (previousSubmissionId) values.previous_submission_id = previousSubmissionId;
  if (!files.length) return values;
  const payload = new FormData();
  Object.entries(values).forEach(([key, value]) => payload.append(key, value));
  appendPhotoUploads(payload, files);
  return payload;
}
