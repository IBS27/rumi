import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import {
  captureTransformSchema,
  MAX_CAPTURE_BYTES,
  parseRoomFile,
  type SavedRoom,
} from "./roomplan";

export const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const path = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-z0-9]+$/);
const positive = z.number().finite().positive();
const size = z.number().int().min(1).max(1920);
const boundedTransform = captureTransformSchema.refine(
  (matrix) => matrix.slice(12, 15).every((value) => Math.abs(value) <= 10_000),
  "Scan poses must be within 10 km of the tracking origin.",
);
export const captureManifestSchema = z.object({
  format: z.literal("rumi.capture"),
  version: z.literal(1),
  coordinates: z.literal("arkit-world-meters-y-up"),
  synthetic: z.boolean().default(false),
  room: z.literal("roomplan.json"),
  meshes: z
    .array(
      z.object({
        positions: path,
        indices: path,
        classifications: path,
        transform: boundedTransform,
        vertexCount: z.number().int().min(3).max(600_000),
        faceCount: z.number().int().min(1).max(300_000),
      }),
    )
    .min(1)
    .max(2048),
  frames: z
    .array(
      z.object({
        image: path,
        depth: path,
        confidence: path,
        width: size,
        height: size,
        depthWidth: z.number().int().min(1).max(512),
        depthHeight: z.number().int().min(1).max(512),
        // Intrinsics are scaled to the JPEG's native sensor orientation, top-left origin.
        fx: positive,
        fy: positive,
        cx: z.number().finite().nonnegative(),
        cy: z.number().finite().nonnegative(),
        cameraTransform: boundedTransform,
        timestamp: z.number().finite().nonnegative(),
      }),
    )
    .max(96),
  warnings: z.array(z.string().max(500)).max(20),
});
export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export type CaptureFrame = CaptureManifest["frames"][number];
export type CapturePackage = {
  manifest: CaptureManifest;
  files: Record<string, Uint8Array>;
  saved: SavedRoom;
};

/** Inspect JPEG dimensions before image decoding can allocate an unbounded bitmap. */
function jpegSize(bytes: Uint8Array): [number, number] | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length)
      return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    }
    offset += length;
  }
  return null;
}

/** Validate lengths before decompression. No network URLs or filesystem extraction. */
export function readPackage(bytes: Uint8Array): CapturePackage {
  if (bytes.byteLength > MAX_PACKAGE_BYTES)
    throw new Error("Choose a scan package smaller than 128 MB.");
  let expanded = 0,
    count = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, {
    filter(entry) {
      if (!path.safeParse(entry.name).success || names.has(entry.name))
        throw new Error("Invalid or duplicate scan file path.");
      names.add(entry.name);
      // STORE copies `size` bytes, while DEFLATE allocates `originalSize`.
      // Reject inconsistent STORE metadata before unzipSync allocates its output.
      if (entry.compression === 0 && entry.size !== entry.originalSize)
        throw new Error("Invalid stored scan file size.");
      expanded += entry.originalSize;
      if (
        ++count > 6500 ||
        expanded > MAX_PACKAGE_BYTES ||
        !Number.isFinite(expanded)
      )
        throw new Error("The scan package expands beyond its size limit.");
      return true;
    },
  });
  const json = (name: string, max = MAX_CAPTURE_BYTES): unknown => {
    const data = files[name];
    if (!data || data.byteLength > max)
      throw new Error(`Missing or oversized ${name}.`);
    return JSON.parse(strFromU8(data));
  };
  const manifest = captureManifestSchema.parse(
    json("manifest.json", 2 * 1024 * 1024),
  );
  const original = json(manifest.room);
  const originalSaved = parseRoomFile(
    JSON.stringify(original),
    "My scanned room",
  );
  const saved = files["edits.json"]
    ? parseRoomFile(strFromU8(files["edits.json"]), "My scanned room")
    : originalSaved;
  if (
    saved.room.shape !== "polygon" ||
    saved.room.id !== originalSaved.room.id ||
    JSON.stringify(saved.original) !== JSON.stringify(originalSaved.original)
  )
    throw new Error("Saved edits do not belong to this scan.");
  saved.room.capture.synthetic = manifest.synthetic;
  // The measured scan always uses the original normalization, never edited dimensions.
  let vertices = 0,
    faces = 0;
  const referenced = new Set(["manifest.json", "roomplan.json", "edits.json"]);
  const reference = (...paths: string[]) => {
    for (const name of paths) {
      if (referenced.has(name))
        throw new Error("Scan buffers and photos must have unique paths.");
      referenced.add(name);
    }
  };
  const exact = (name: string, length: number) => {
    if (files[name]?.byteLength !== length)
      throw new Error(`Invalid scan buffer: ${name}.`);
  };
  for (const mesh of manifest.meshes) {
    reference(mesh.positions, mesh.indices, mesh.classifications);
    vertices += mesh.vertexCount;
    faces += mesh.faceCount;
    if (vertices > 600_000 || faces > 300_000)
      throw new Error("This scan has too much geometry.");
    exact(mesh.positions, mesh.vertexCount * 12);
    exact(mesh.indices, mesh.faceCount * 12);
    exact(mesh.classifications, mesh.faceCount);
    const p = floatBuffer(files[mesh.positions]);
    if (p.some((n) => !Number.isFinite(n) || Math.abs(n) > 1000))
      throw new Error("Invalid mesh coordinates.");
    const index = uintBuffer(files[mesh.indices]);
    if (index.some((n) => n >= mesh.vertexCount))
      throw new Error("A mesh face references a missing vertex.");
    if (files[mesh.classifications].some((n) => n > 7))
      throw new Error("Invalid surface classification.");
  }
  let photoPixels = 0;
  for (const frame of manifest.frames) {
    reference(frame.image, frame.depth, frame.confidence);
    photoPixels += frame.width * frame.height;
    if (photoPixels > 72_000_000)
      throw new Error("The scan contains too many photo pixels.");
    if (frame.cx >= frame.width || frame.cy >= frame.height)
      throw new Error("Invalid camera calibration.");
    exact(frame.depth, frame.depthWidth * frame.depthHeight * 4);
    exact(frame.confidence, frame.depthWidth * frame.depthHeight);
    if (files[frame.confidence].some((n) => n > 2))
      throw new Error("Invalid depth confidence.");
    const jpeg = files[frame.image];
    if (
      !jpeg ||
      jpeg.byteLength > 2 * 1024 * 1024 ||
      jpeg[0] !== 0xff ||
      jpeg[1] !== 0xd8
    )
      throw new Error("Missing or invalid scan photo.");
    const dimensions = jpegSize(jpeg);
    if (
      !dimensions ||
      dimensions[0] !== frame.width ||
      dimensions[1] !== frame.height
    )
      throw new Error("A scan photo does not match its camera calibration.");
  }
  return { manifest, files, saved };
}

// Copy unaligned ZIP views; buffers are explicitly little-endian in version 1.
export function floatBuffer(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}
export function uintBuffer(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.byteLength / 4 }, (_, i) =>
    view.getUint32(i * 4, true),
  );
}
export function exportPackage(bytes: Uint8Array, saved: SavedRoom): Uint8Array {
  const capture = readPackage(bytes);
  // Parse again on import so edits remain validated exactly like standalone saved rooms.
  const edits = parseRoomFile(JSON.stringify(saved), saved.room.name);
  if (
    edits.room.id !== capture.saved.room.id ||
    JSON.stringify(edits.original) !== JSON.stringify(capture.saved.original)
  )
    throw new Error("Cannot attach edits from another room.");
  capture.files["edits.json"] = strToU8(JSON.stringify(edits));
  const result = zipSync(capture.files, { level: 0 });
  if (result.byteLength > MAX_PACKAGE_BYTES)
    throw new Error("The exported scan exceeds 128 MB.");
  return result;
}
