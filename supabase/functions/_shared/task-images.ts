import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, THUMBNAIL_MAX_BYTES, THUMBNAIL_EDGE, photoDimensions } from "./photo-metadata.js";

export const TASK_IMAGE_BUCKET = "crm-task-images";
export const MAX_TASK_IMAGES = 10;
export const MAX_TASK_IMAGE_BYTES = PHOTO_MAX_BYTES;

export class TaskImageError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Check the file signature as well as the browser's claimed MIME type. SVG and
// other executable formats are deliberately excluded from task attachments.
export async function validateTaskImages(files: File[], thumbnails: File[] = []) {
  if (files.length > MAX_TASK_IMAGES) throw new TaskImageError(400, "Upload up to 10 photos per stage.");
  if (thumbnails.length && thumbnails.length !== files.length) throw new TaskImageError(400, "Each photo needs its matching thumbnail.");
  const validate = async (file: File, maxBytes: number, maxEdge: number) => {
    if (!file.size || file.size > maxBytes) {
      throw new TaskImageError(400, `${file.name}: photo upload is too large. Select it again to compress it before uploading.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    const valid =
      (file.type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      (file.type === "image/png" && bytes.slice(0, 8).join() === "137,80,78,71,13,10,26,10") ||
      (file.type === "image/webp" && text(0, 4) === "RIFF" && text(8, 12) === "WEBP");
    const dimensions = valid ? photoDimensions(bytes) : null;
    if (!dimensions || Math.max(dimensions.width, dimensions.height) > maxEdge) {
      throw new TaskImageError(400, `${file.name}: select this photo again so it can be resized and compressed.`);
    }
    return dimensions;
  };
  const metadata = [];
  for (let index = 0; index < files.length; index++) {
    const dimensions = await validate(files[index], PHOTO_MAX_BYTES, PHOTO_MAX_EDGE);
    if (thumbnails[index]) {
      const thumb = await validate(thumbnails[index], THUMBNAIL_MAX_BYTES, THUMBNAIL_EDGE);
      if (Math.abs(dimensions.width * thumb.height - dimensions.height * thumb.width) > Math.max(dimensions.width, dimensions.height) * 2) {
        throw new TaskImageError(400, "The photo and thumbnail do not match. Select the photos again.");
      }
    } else if (files[index].size > THUMBNAIL_MAX_BYTES) {
      throw new TaskImageError(400, "Select the photos again to generate small thumbnails before uploading.");
    }
    metadata.push({ width: dimensions.width, height: dimensions.height, byte_size: files[index].size,
      thumbnail_byte_size: thumbnails[index]?.size || null });
  }
  return metadata;
}

const extensions: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/bmp": "bmp", "image/avif": "avif",
};

function taskDbError(error: any): TaskImageError {
  return new TaskImageError(error.code === "42501" ? 403 : error.code === "P0002" ? 404 : ["P0001", "40001"].includes(error.code) ? 409 : 400,
    error.message || "Unable to save task.");
}

export async function reviewTaskSubmission(client: any, actor: string, taskId: number, submissionId: number, action: string, note: string) {
  const { data, error } = await client.rpc("crm_review_task_submission", {
    p_task_id: taskId, p_submission_id: submissionId, p_actor: actor, p_action: action, p_note: note,
  });
  if (error) throw taskDbError(error);
  return data;
}

// Upload first, then commit the task and all attachment rows in one transaction.
// If either step fails, remove every object created by this request.
export async function uploadPhotoObjects(client: any, bucketName: string, prefix: string, files: File[], thumbnails: File[] = []) {
  const metadata = await validateTaskImages(files, thumbnails);
  const bucket = client.storage.from(bucketName);
  const paths: string[] = [];
  const images = [];
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index], id = crypto.randomUUID();
      const path = `${prefix}/${id}.${extensions[file.type]}`;
      const { error } = await bucket.upload(path, file, { contentType: file.type, upsert: false, cacheControl: "31536000" });
      if (error) throw new TaskImageError(502, "Photo upload failed. Please try again.");
      paths.push(path);
      let thumbnailPath = null;
      if (thumbnails[index]) {
        const thumb = thumbnails[index];
        thumbnailPath = `${prefix}/${id}.thumb.${extensions[thumb.type]}`;
        const { error } = await bucket.upload(thumbnailPath, thumb, { contentType: thumb.type, upsert: false, cacheControl: "31536000" });
        if (error) throw new TaskImageError(502, "Thumbnail upload failed. Please try again.");
        paths.push(thumbnailPath);
      }
      images.push({ storage_path: path, original_name: file.name.slice(0, 255), thumbnail_path: thumbnailPath, ...metadata[index] });
    }
    return { images, paths };
  } catch (error) {
    if (paths.length) await bucket.remove(paths);
    throw error;
  }
}

export async function saveTaskPhotos(client: any, actor: string, taskId: number | null,
  stage: "assignment" | "completion", values: any, files: File[], thumbnails: File[] = []) {
  const bucket = client.storage.from(TASK_IMAGE_BUCKET);
  const uploaded = await uploadPhotoObjects(client, TASK_IMAGE_BUCKET, actor, files, thumbnails);
  try {
    const { data, error } = await client.rpc("crm_save_task_photos", {
      p_task_id: taskId, p_actor: actor, p_stage: stage, p_values: values, p_images: uploaded.images,
    });
    if (error) throw taskDbError(error);
    return data;
  } catch (error) {
    if (uploaded.paths.length) {
      const { error: cleanupError } = await bucket.remove(uploaded.paths);
      if (cleanupError) console.error("Task photo cleanup failed:", cleanupError.message);
    }
    throw error;
  }
}

// Keep URLs stable between live feed polls. Refresh well before the one-hour
// expiry; the API still checks task access before calling this function.
const signedUrls = new Map<string, { url: string; refreshAt: number }>();
export async function signedTaskImages(client: any, rows: any[], bucketName = TASK_IMAGE_BUCKET) {
  const paths = [...new Set(rows.flatMap((row) => [row.storage_path, row.thumbnail_path]).filter(Boolean))];
  const urls = new Map<string, string>();
  const missing = paths.filter((path) => {
    const cached = signedUrls.get(`${bucketName}/${path}`);
    if (cached && cached.refreshAt > Date.now()) { urls.set(path, cached.url); return false; }
    return true;
  });
  for (let offset = 0; offset < missing.length; offset += 200) {
    const { data, error } = await client.storage.from(bucketName)
      .createSignedUrls(missing.slice(offset, offset + 200), 3600);
    if (error || data?.some((item: any) => item.error || !item.signedUrl)) {
      throw new TaskImageError(502, "Unable to load task photos. Please try again.");
    }
    for (const item of data || []) {
      if (signedUrls.size >= 2000) signedUrls.delete(signedUrls.keys().next().value!);
      signedUrls.set(`${bucketName}/${item.path}`, { url: item.signedUrl, refreshAt: Date.now() + 45 * 60 * 1000 });
      urls.set(item.path, item.signedUrl);
    }
  }
  return rows.map((row) => ({
    id: row.id, task_id: row.task_id, stage: row.stage, submission_id: row.submission_id, original_name: row.original_name,
    uploaded_at: row.uploaded_at, url: urls.get(row.storage_path), thumbnail_url: urls.get(row.thumbnail_path) || urls.get(row.storage_path),
    byte_size: row.byte_size, thumbnail_byte_size: row.thumbnail_byte_size, width: row.width, height: row.height,
  }));
}
