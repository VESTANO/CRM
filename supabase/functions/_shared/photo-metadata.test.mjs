import assert from "node:assert/strict";
import test from "node:test";
import { photoDimensions, fitPhoto } from "./photo-metadata.js";

function jpeg(width, height, orientation = 1, little = true) {
  const sof = Buffer.from([255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0]);
  const exif = Buffer.alloc(36);
  exif.set([255, 225, 0, 34]); exif.write("Exif\0\0", 4, "ascii");
  exif.write(little ? "II" : "MM", 10, "ascii");
  const u16 = (value, offset) => little ? exif.writeUInt16LE(value, offset) : exif.writeUInt16BE(value, offset);
  const u32 = (value, offset) => little ? exif.writeUInt32LE(value, offset) : exif.writeUInt32BE(value, offset);
  u16(42, 12); u32(8, 14); u16(1, 18); u16(274, 20); u16(3, 22); u32(1, 24); u16(orientation, 28);
  return Buffer.concat([Buffer.from([255, 216]), exif, sof, Buffer.from([255, 217])]);
}

test("reads actual PNG headers and rejects empty, truncated and zero-sized headers", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  assert.deepEqual(photoDimensions(png), { width: 1, height: 1, orientation: 1 });
  assert.equal(photoDimensions(new Uint8Array()), null);
  assert.equal(photoDimensions(png.subarray(0, 20)), null);
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16);
  assert.equal(photoDimensions(zero), null);
  // Typed array views must respect their offset inside a larger buffer.
  const padded = Buffer.concat([Buffer.alloc(9), png, Buffer.alloc(7)]);
  assert.deepEqual(photoDimensions(padded.subarray(9, 9 + png.length)), { width: 1, height: 1, orientation: 1 });
});

test("JPEG EXIF rotation uses the displayed dimensions in both TIFF byte orders", () => {
  for (const little of [true, false]) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      assert.deepEqual(photoDimensions(jpeg(3000, 2000, orientation, little)), {
        width: orientation >= 5 ? 2000 : 3000,
        height: orientation >= 5 ? 3000 : 2000,
        orientation,
      });
    }
  }
  assert.equal(photoDimensions(new Uint8Array([255, 216, 255, 225, 0, 1])), null);
});

test("reads GIF and both BMP dimension layouts including top-down images", () => {
  const gif = Buffer.alloc(13); gif.write("GIF89a"); gif.writeUInt16LE(400, 6); gif.writeUInt16LE(300, 8);
  assert.deepEqual(photoDimensions(gif), { width: 400, height: 300, orientation: 1 });
  const bmp = Buffer.alloc(54); bmp.write("BM"); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(800, 18); bmp.writeInt32LE(-600, 22);
  assert.deepEqual(photoDimensions(bmp), { width: 800, height: 600, orientation: 1 });
  const core = Buffer.alloc(26); core.write("BM"); core.writeUInt32LE(12, 14); core.writeUInt16LE(120, 18); core.writeUInt16LE(90, 20);
  assert.deepEqual(photoDimensions(core), { width: 120, height: 90, orientation: 1 });
});

test("reads lossy, lossless and extended WebP headers", () => {
  const header = (chunk) => { const bytes = Buffer.alloc(32); bytes.write("RIFF"); bytes.write("WEBP", 8); bytes.write(chunk, 12); return bytes; };
  const lossy = header("VP8 "); lossy.set([157, 1, 42], 23); lossy.writeUInt16LE(1280, 26); lossy.writeUInt16LE(720, 28);
  const lossless = header("VP8L"); lossless[20] = 47; lossless.writeUInt32LE((1280 - 1) | ((720 - 1) << 14), 21);
  const extended = header("VP8X"); extended.writeUIntLE(1280 - 1, 24, 3); extended.writeUIntLE(720 - 1, 27, 3);
  for (const bytes of [lossy, lossless, extended]) assert.deepEqual(photoDimensions(bytes), { width: 1280, height: 720, orientation: 1 });
});

test("reads AVIF image spatial extents", () => {
  const bytes = Buffer.alloc(48); bytes.write("ftyp", 4); bytes.write("avif", 8); bytes.write("ispe", 20); bytes.writeUInt32BE(4032, 28); bytes.writeUInt32BE(3024, 32);
  assert.deepEqual(photoDimensions(bytes), { width: 4032, height: 3024, orientation: 1 });
});

test("resizing bounds the longer edge, preserves aspect ratio and never enlarges", () => {
  assert.deepEqual(fitPhoto(4032, 3024, 1280), { width: 1280, height: 960 });
  assert.deepEqual(fitPhoto(3024, 4032, 256), { width: 192, height: 256 });
  assert.deepEqual(fitPhoto(120, 90, 1280), { width: 120, height: 90 });
  assert.deepEqual(fitPhoto(32768, 1, 256), { width: 256, height: 1 });
});
