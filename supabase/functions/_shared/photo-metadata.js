// Shared by browser compression and API validation. No decoder or native
// dependency is needed to reject an oversized upload or a decompression bomb.
export const PHOTO_MAX_EDGE = 1280;
export const PHOTO_MAX_BYTES = 256 * 1024;
export const PHOTO_TARGET_BYTES = 160 * 1024;
export const THUMBNAIL_EDGE = 256;
export const THUMBNAIL_MAX_BYTES = 20 * 1024;
export const THUMBNAIL_TARGET_BYTES = 12 * 1024;
export const PHOTO_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export function photoDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  let width, height, orientation = 1;
  try {
    if (text(1, 4) === "PNG" && bytes[0] === 137) {
      width = view.getUint32(16); height = view.getUint32(20);
    } else if (text(0, 3) === "GIF") {
      width = view.getUint16(6, true); height = view.getUint16(8, true);
    } else if (text(0, 2) === "BM") {
      const small = view.getUint32(14, true) === 12;
      width = small ? view.getUint16(18, true) : view.getInt32(18, true);
      height = small ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true));
    } else if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
      const chunk = text(12, 16);
      if (chunk === "VP8X") {
        width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
        height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      } else if (chunk === "VP8L" && bytes[20] === 47) {
        const bits = view.getUint32(21, true);
        width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
      } else if (chunk === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
        width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
      }
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      for (let offset = 2; offset + 8 < bytes.length;) {
        if (bytes[offset] !== 255) break;
        const marker = bytes[offset + 1];
        if (marker === 255) { offset++; continue; }
        if (marker === 218 || marker === 217) break;
        const length = view.getUint16(offset + 2);
        if (length < 2) break;
        if (marker === 225 && text(offset + 4, offset + 10) === "Exif\0\0") {
          const tiff = offset + 10, little = text(tiff, tiff + 2) === "II";
          const directory = tiff + view.getUint32(tiff + 4, little);
          const entries = view.getUint16(directory, little);
          for (let index = 0; index < Math.min(entries, 512); index++) {
            const entry = directory + 2 + index * 12;
            if (view.getUint16(entry, little) === 274) { orientation = view.getUint16(entry + 8, little); break; }
          }
        }
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
          height = view.getUint16(offset + 5); width = view.getUint16(offset + 7);
        }
        offset += 2 + length;
      }
    } else if (text(4, 8) === "ftyp") {
      for (let offset = 8; offset + 16 <= bytes.length; offset++) {
        if (text(offset, offset + 4) === "ispe") { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); break; }
      }
    }
  } catch { /* Incomplete or invalid headers are rejected below. */ }
  if (!(width > 0 && height > 0)) return null;
  if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
  return { width, height, orientation };
}

export function fitPhoto(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
