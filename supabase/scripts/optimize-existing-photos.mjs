#!/usr/bin/env node
// Run from the repository root. This only reads remote data unless --apply is
// supplied. Originals and a recovery journal are kept in ignored tmp/ before
// any referenced Storage object is replaced. No credentials are written there.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, PHOTO_MAX_SOURCE_BYTES, PHOTO_TARGET_BYTES,
  THUMBNAIL_EDGE, THUMBNAIL_MAX_BYTES, THUMBNAIL_TARGET_BYTES, photoDimensions,
} from "../functions/_shared/photo-metadata.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
let apply = false, project = "qdtgrddhpbwrutvojpes", sharpModule;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flag === "--apply") apply = true;
  else if (flag === "--project" && args[index + 1]) project = args[++index];
  else if (flag === "--sharp-module" && args[index + 1]) sharpModule = args[++index];
  else if (flag === "--help") {
    console.log("Usage: node supabase/scripts/optimize-existing-photos.mjs [--apply] [--project <ref>] [--sharp-module <path>]\nDefault: dry run. --apply backs up originals in ignored tmp/photo-optimization/ before replacement.");
    process.exit(0);
  } else throw new Error(`Unknown or incomplete option: ${flag}`);
}
if (!/^[a-z0-9]{20}$/.test(project)) throw new Error("Invalid project reference.");
const sharp = (await import(sharpModule ? pathToFileURL(path.resolve(sharpModule)).href : "sharp")).default;
const variants = [
  { table: "crm_task_images", bucket: "crm-task-images" },
  { table: "crm_visit_images", bucket: "crm-visit-images" },
];
const metadataFields = ["storage_path", "thumbnail_path", "byte_size", "thumbnail_byte_size", "width", "height"];
const apiRoot = `https://${project}.supabase.co`;
let cliKeys;
try {
  const command = `npx.cmd --no-install supabase projects api-keys --remote=${project} --reveal --output json`;
  const raw = process.platform === "win32"
    ? execFileSync(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    : execFileSync("npx", ["--no-install", "supabase", "projects", "api-keys", `--remote=${project}`, "--reveal", "--output", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  cliKeys = JSON.parse(raw);
} catch {
  throw new Error("Unable to read the project's API key through the authenticated Supabase CLI.");
}
const keyRows = Array.isArray(cliKeys) ? cliKeys : cliKeys.keys || cliKeys.api_keys || [];
const serviceKey = keyRows.find((item) => item.name === "service_role")?.api_key;
if (!serviceKey) throw new Error("The project service role API key was not returned by the CLI.");
cliKeys = undefined;
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const encodeObject = (value) => value.split("/").map(encodeURIComponent).join("/");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const backupRoot = path.resolve(root, "tmp", "photo-optimization", new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID());
if (!backupRoot.startsWith(path.resolve(root, "tmp") + path.sep)) throw new Error("Backup directory must stay inside the workspace tmp directory.");
let journal;
const report = {
  mode: apply ? "apply" : "dry-run", project, scannedPhotos: 0, candidatePhotos: 0,
  optimizedPhotos: 0, beforeBytes: 0, afterBytes: 0, cleanupPending: 0, failedPhotos: 0,
};
async function record(entry) {
  if (!apply) return;
  if (!journal) {
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    journal = path.join(backupRoot, "journal.jsonl");
    await writeFile(journal, "", { mode: 0o600, flag: "wx" });
  }
  await appendFile(journal, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
async function request(resource, options = {}, action = "remote request") {
  let response;
  try {
    response = await fetch(apiRoot + resource, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000) });
  } catch {
    throw new Error(`Network failure during ${action}.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} during ${action}.`);
  }
  return response;
}
async function download(bucket, object, maxBytes = PHOTO_MAX_SOURCE_BYTES) {
  const response = await request(`/storage/v1/object/authenticated/${bucket}/${encodeObject(object)}`, {}, "image download");
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Stored image exceeds the maintenance input limit.");
  }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error("Stored image exceeds the maintenance input limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}
async function upload(bucket, object, bytes, contentType) {
  await request(`/storage/v1/object/${bucket}/${encodeObject(object)}`, {
    method: "POST", headers: { "Content-Type": contentType, "Cache-Control": "max-age=31536000", "x-upsert": "false" }, body: bytes,
  }, "optimized image upload");
}
async function removeObjects(bucket, objects) {
  if (!objects.length) return;
  await request(`/storage/v1/object/${bucket}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [...new Set(objects)] }),
  }, "replaced image removal");
}
function rowQuery(row) {
  const query = new URLSearchParams({ id: `eq.${row.id}`, storage_path: `eq.${row.storage_path}` });
  // Compare all known attachment metadata, so another optimizer cannot have its
  // thumbnail or size changes silently overwritten while this job is encoding.
  for (const field of metadataFields.filter((field) => field !== "storage_path")) {
    if (Object.hasOwn(row, field)) query.set(field, row[field] == null ? "is.null" : `eq.${row[field]}`);
  }
  return query;
}
async function replaceRow(table, current, replacement) {
  const response = await request(`/rest/v1/${table}?${rowQuery(current)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(replacement),
  }, "image metadata update");
  const rows = await response.json();
  if (rows.length !== 1) throw new Error("Image changed during optimization; its old object has been retained.");
  return rows[0];
}
async function compressed(input, edge, target, hardLimit) {
  for (let round = 0; round < 8; round++) {
    const size = Math.max(1, Math.floor(edge * 0.8 ** round));
    let encoded;
    for (const quality of [76, 62, 50, 40, 30, 20]) {
      encoded = await sharp(input, { limitInputPixels: 120000000 }).rotate()
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 5 }).toBuffer();
      if (encoded.length <= target) return encoded;
    }
    if (encoded.length <= hardLimit) return encoded;
  }
  throw new Error("Could not compress an existing photo within the image budget.");
}
async function optimize(input) {
  const source = await sharp(input, { limitInputPixels: 120000000 }).metadata();
  let full = await compressed(input, PHOTO_MAX_EDGE, PHOTO_TARGET_BYTES, PHOTO_MAX_BYTES);
  let contentType = "image/webp", extension = "webp";
  const sourceDimensions = photoDimensions(input);
  if (["jpeg", "png", "webp"].includes(source.format) && sourceDimensions &&
      Math.max(sourceDimensions.width, sourceDimensions.height) <= PHOTO_MAX_EDGE && input.length < full.length) {
    full = input;
    extension = source.format === "jpeg" ? "jpg" : source.format;
    contentType = `image/${source.format}`;
  }
  const dimensions = photoDimensions(full);
  if (!dimensions || Math.max(dimensions.width, dimensions.height) > PHOTO_MAX_EDGE || full.length > PHOTO_MAX_BYTES) throw new Error("Invalid optimized image dimensions or size.");
  const useFullAsThumbnail = Math.max(dimensions.width, dimensions.height) <= THUMBNAIL_EDGE && full.length <= THUMBNAIL_MAX_BYTES;
  const thumbnail = useFullAsThumbnail ? full : await compressed(full, THUMBNAIL_EDGE, THUMBNAIL_TARGET_BYTES, THUMBNAIL_MAX_BYTES);
  return { full, thumbnail, contentType, extension, dimensions, useFullAsThumbnail };
}
async function rowsFor(table) {
  const rows = [];
  for (let offset = 0;; offset += 1000) {
    const page = await (await request(`/rest/v1/${table}?select=*&order=id&limit=1000&offset=${offset}`, {}, "image metadata listing")).json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
for (const { table, bucket } of variants) {
  const rows = await rowsFor(table);
  for (const row of rows) {
    report.scannedPhotos++;
    if (row.thumbnail_path && row.byte_size > 0 && row.byte_size <= PHOTO_MAX_BYTES &&
        row.thumbnail_byte_size > 0 && row.thumbnail_byte_size <= THUMBNAIL_MAX_BYTES &&
        row.width > 0 && row.width <= PHOTO_MAX_EDGE && row.height > 0 && row.height <= PHOTO_MAX_EDGE) continue;
    report.candidatePhotos++;
    let uploadedPaths = [], patched = false, committed = false;
    const originalMetadata = Object.fromEntries(metadataFields.map((field) => [field, row[field] ?? null]));
    let replacement;
    try {
      const original = await download(bucket, row.storage_path);
      const oldThumbnail = row.thumbnail_path && row.thumbnail_path !== row.storage_path ? await download(bucket, row.thumbnail_path) : null;
      const optimized = await optimize(original);
      const beforeBytes = original.length + (oldThumbnail?.length || 0);
      const afterBytes = optimized.full.length + (optimized.useFullAsThumbnail ? 0 : optimized.thumbnail.length);
      if (!apply) { report.beforeBytes += beforeBytes; report.afterBytes += afterBytes; continue; }
      await record({ table, id: row.id, stage: "preparing", originalMetadata });
      const backupName = `${table}-${row.id}-${randomUUID()}.original`;
      const originalBackup = path.join(backupRoot, backupName);
      await writeFile(originalBackup, original, { mode: 0o600, flag: "wx" });
      if (digest(await readFile(originalBackup)) !== digest(original)) throw new Error("Original backup verification failed.");
      let thumbnailBackup;
      if (oldThumbnail) {
        thumbnailBackup = `${backupName}.thumbnail`;
        await writeFile(path.join(backupRoot, thumbnailBackup), oldThumbnail, { mode: 0o600, flag: "wx" });
        if (digest(await readFile(path.join(backupRoot, thumbnailBackup))) !== digest(oldThumbnail)) throw new Error("Thumbnail backup verification failed.");
      }
      const directory = path.posix.dirname(row.storage_path);
      const prefix = directory === "." ? "" : directory + "/";
      const newPath = `${prefix}${randomUUID()}.${optimized.extension}`;
      const thumbnailPath = optimized.useFullAsThumbnail ? newPath : `${prefix}${randomUUID()}.thumb.webp`;
      replacement = {
        storage_path: newPath, thumbnail_path: thumbnailPath, byte_size: optimized.full.length,
        thumbnail_byte_size: optimized.thumbnail.length, width: optimized.dimensions.width, height: optimized.dimensions.height,
      };
      await record({ table, id: row.id, stage: "backed_up", backupName, thumbnailBackup, originalSha256: digest(original), originalMetadata, replacement });
      await upload(bucket, newPath, optimized.full, optimized.contentType);
      uploadedPaths.push(newPath);
      if (!optimized.useFullAsThumbnail) {
        await upload(bucket, thumbnailPath, optimized.thumbnail, "image/webp");
        uploadedPaths.push(thumbnailPath);
      }
      const verifiedFull = await download(bucket, newPath, PHOTO_MAX_BYTES);
      const verifiedThumbnail = optimized.useFullAsThumbnail ? verifiedFull : await download(bucket, thumbnailPath, THUMBNAIL_MAX_BYTES);
      if (digest(verifiedFull) !== digest(optimized.full) || digest(verifiedThumbnail) !== digest(optimized.thumbnail)) throw new Error("Uploaded image verification failed.");
      const thumbnailDimensions = photoDimensions(verifiedThumbnail);
      if (!thumbnailDimensions || Math.max(thumbnailDimensions.width, thumbnailDimensions.height) > THUMBNAIL_EDGE) throw new Error("Uploaded thumbnail dimensions are invalid.");
      patched = true;
      // Mark the write as ambiguous before sending it: a lost response may
      // follow a committed database update. Never remove the new objects until
      // a compare-and-swap rollback has confirmed that they are unreferenced.
      await replaceRow(table, row, replacement);
      const check = await (await request(`/rest/v1/${table}?${rowQuery({ id: row.id, ...replacement })}&select=*`, {}, "updated metadata verification")).json();
      if (check.length !== 1 || metadataFields.some((field) => check[0][field] !== replacement[field])) throw new Error("Updated image metadata could not be verified.");
      await record({ table, id: row.id, stage: "committed", originalMetadata, replacement, beforeBytes, afterBytes });
      committed = true;
      report.optimizedPhotos++; report.beforeBytes += beforeBytes; report.afterBytes += afterBytes;
      try {
        await removeObjects(bucket, [row.storage_path, row.thumbnail_path].filter((object) => object && !uploadedPaths.includes(object)));
        await record({ table, id: row.id, stage: "old_objects_removed" });
      } catch (error) {
        report.cleanupPending++;
        await record({ table, id: row.id, stage: "cleanup_pending", error: error.message });
      }
    } catch (error) {
      report.failedPhotos++;
      let rollbackSafe = !patched;
      if (patched && !committed) {
        try {
          await replaceRow(table, { id: row.id, ...replacement }, originalMetadata);
          rollbackSafe = true;
        } catch { /* Preserve both object versions for recovery if row rollback fails. */ }
      }
      if (rollbackSafe && uploadedPaths.length) {
        try { await removeObjects(bucket, uploadedPaths); } catch { report.cleanupPending++; }
      }
      await record({ table, id: row.id, stage: rollbackSafe ? "failed_original_preserved" : "recovery_required", error: error.message, originalMetadata, replacement });
      console.error(`Photo optimization failed (${table}): ${error.message}`);
    }
  }
}
report.savedBytes = report.beforeBytes - report.afterBytes;
report.savedPercent = report.beforeBytes ? Math.round(10000 * report.savedBytes / report.beforeBytes) / 100 : 0;
if (apply && journal) report.backupDirectory = backupRoot;
console.log(JSON.stringify(report, null, 2));
if (report.failedPhotos || report.cleanupPending) process.exitCode = 1;
