import {
  PHOTO_MAX_EDGE, PHOTO_MAX_BYTES, PHOTO_TARGET_BYTES, THUMBNAIL_EDGE,
  THUMBNAIL_MAX_BYTES, THUMBNAIL_TARGET_BYTES, PHOTO_MAX_SOURCE_BYTES, photoDimensions, fitPhoto,
} from "../../../supabase/functions/_shared/photo-metadata.js";

export { PHOTO_MAX_SOURCE_BYTES };
const cancelled = (signal) => { if (signal?.aborted) throw new DOMException("Photo preparation cancelled.", "AbortError"); };
const canvas = (width, height) => {
  const result = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
  result.width = width; result.height = height;
  return result;
};
async function encode(surface, type, quality) {
  if (surface.convertToBlob) return surface.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => surface.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to compress this photo.")), type, quality));
}

async function compressedVersion(source, edge, targetBytes, maxBytes, signal) {
  let size = fitPhoto(source.width, source.height, edge);
  const output = canvas(size.width, size.height);
  let best;
  try {
    for (let attempt = 0; attempt < 7; attempt++) {
      cancelled(signal);
      output.width = size.width; output.height = size.height;
      const context = output.getContext("2d");
      if (!context) throw new Error("Photo compression is unavailable in this browser.");
      context.drawImage(source, 0, 0, size.width, size.height);
      for (const quality of [.76, .62, .5, .4]) {
        cancelled(signal);
        let blob = await encode(output, "image/webp", quality);
        if (blob.type !== "image/webp") {
          context.globalCompositeOperation = "destination-over"; context.fillStyle = "#fff";
          context.fillRect(0, 0, size.width, size.height); context.globalCompositeOperation = "source-over";
          blob = await encode(output, "image/jpeg", quality);
        }
        if (!best || blob.size < best.blob.size) best = { blob, ...size };
        if (blob.size <= targetBytes) return { blob, ...size };
      }
      size = fitPhoto(size.width, size.height, Math.max(1, Math.floor(Math.max(size.width, size.height) * .8)));
    }
    if (best?.blob.size <= maxBytes) return best;
    throw new Error("This photo could not be compressed enough. Please choose a smaller version.");
  } finally { output.width = 1; output.height = 1; }
}

async function decode(file, dimensions) {
  if (typeof createImageBitmap === "function") {
    const size = dimensions ? fitPhoto(dimensions.width, dimensions.height, PHOTO_MAX_EDGE) : null;
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image", ...(size ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" } : {}) });
    return { source: bitmap, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    return { source: image, close: () => { image.src = ""; URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export function photoSourceKey(file) { return file.sourceKey || `${file.name}:${file.size}:${file.lastModified}`; }

export async function optimizePhoto(file, { signal } = {}) {
  cancelled(signal);
  if (!file.size || file.size > PHOTO_MAX_SOURCE_BYTES) throw new Error(`${file.name}: choose an original photo up to 100 MB.`);
  const dimensions = photoDimensions(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  if (dimensions && (dimensions.width * dimensions.height > 120_000_000 || Math.max(dimensions.width, dimensions.height) > 32768)) {
    throw new Error(`${file.name}: this image has too many pixels. Please choose a smaller export.`);
  }
  cancelled(signal);
  let decoded;
  const surface = canvas(1, 1);
  try {
    decoded = await decode(file, dimensions);
    cancelled(signal);
    const size = fitPhoto(decoded.source.width, decoded.source.height, PHOTO_MAX_EDGE);
    surface.width = size.width; surface.height = size.height;
    const context = surface.getContext("2d");
    if (!context) throw new Error("Photo compression is unavailable in this browser.");
    context.drawImage(decoded.source, 0, 0, size.width, size.height);
    decoded.close(); decoded = null;
    const full = await compressedVersion(surface, PHOTO_MAX_EDGE, PHOTO_TARGET_BYTES, PHOTO_MAX_BYTES, signal);
    const thumbnail = await compressedVersion(surface, THUMBNAIL_EDGE, THUMBNAIL_TARGET_BYTES, THUMBNAIL_MAX_BYTES, signal);
    cancelled(signal);
    const canKeepSmaller = dimensions && Math.max(dimensions.width, dimensions.height) <= PHOTO_MAX_EDGE &&
      ["image/webp", "image/jpeg", "image/png"].includes(file.type) && file.size < full.blob.size && file.size <= PHOTO_MAX_BYTES;
    const optimized = new File([canKeepSmaller ? file : full.blob], file.name, { type: canKeepSmaller ? file.type : full.blob.type, lastModified: file.lastModified });
    Object.assign(optimized, {
      thumbnail: new File([thumbnail.blob], "thumbnail.webp", { type: thumbnail.blob.type }),
      originalSize: file.size, sourceKey: photoSourceKey(file), width: canKeepSmaller ? dimensions.width : full.width,
      height: canKeepSmaller ? dimensions.height : full.height,
    });
    return optimized;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`${file.name}: ${error.message || "Unable to prepare this image. Choose another photo."}`);
  } finally { decoded?.close(); surface.width = 1; surface.height = 1; }
}

export function appendPhotoUploads(payload, files) {
  files.forEach((file) => payload.append("images", file));
  if (files.length && files.every((file) => file.thumbnail)) files.forEach((file) => payload.append("image_thumbnails", file.thumbnail));
}

export function formatPhotoBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
