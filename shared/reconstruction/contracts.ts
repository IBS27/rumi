import { z } from "zod";
import { clearEmbeddedDecor } from "./cleanup";
import {
  roomSchema,
  categorySchema,
  vectorSchema,
  dimensionsSchema,
  type CapturedRoom,
  type ReconstructionRecord,
  type RoomObject,
  type RoomSnapshot,
} from "../contracts";
import { captureTransformSchema } from "../capture/roomplan";
import type { DesignCommand } from "../design/contracts";
import { materialDetailSchema } from "../assets/materials";
import {
  materialKindSchema,
  parametricPartSchema,
  rotatedHalfExtents,
} from "../assets/model";

export const RECONSTRUCTION_VERSION = 1;
// Include the appearance revision in the cache key so older flat scenes are upgraded.
export const RECONSTRUCTION_APPEARANCE = 5;
export const RECONSTRUCTION_MODEL = "gpt-6-astra";
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_SCENE_BYTES = 750_000;
export const MAX_RECONSTRUCTION_MS = 8 * 60_000;

const coordinate = z.number().finite().min(-10_000).max(10_000);
export const surfaceObservationSchema = z.object({
  surfaceId: z.string().min(1).max(160),
  side: z.enum(["front", "back"]),
  photoIndex: z.number().int().min(0).max(15),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  samples: z.number().int().min(8).max(100),
});
export const reconstructionInputSchema = z.object({
  version: z.literal(1),
  // Measured RGB evidence, not lighting-calibrated albedo. Optional for old scans.
  surfaceObservations: z.array(surfaceObservationSchema).max(2580).optional(),
  room: roomSchema.refine(
    (room) => room.shape === "polygon" && room.objects.length <= 96,
    "Reconstruction needs a captured room with at most 96 objects.",
  ),
  // World-space triangle samples, normalized with the ORIGINAL RoomPlan origin.
  mesh: z.object({
    faceCount: z.number().int().positive().max(300_000),
    samples: z
      .array(
        z.object({
          vertices: z.array(coordinate).length(9),
          classification: z.number().int().min(0).max(7),
        }),
      )
      .min(1)
      .max(1200),
  }),
  photos: z
    .array(
      z.object({
        jpeg: z
          .string()
          .max(300_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        width: z.number().int().min(1).max(1024),
        height: z.number().int().min(1).max(1024),
        cameraTransform: captureTransformSchema,
        fx: z.number().positive(),
        fy: z.number().positive(),
        cx: z.number().nonnegative(),
        cy: z.number().nonnegative(),
      }),
    )
    .min(
      1,
      "This scan has no photos. Import a scan with photos to reconstruct its appearance.",
    )
    .max(16),
}).superRefine((input, ctx) => {
  if (input.room.shape !== "polygon") return;
  const ids = new Set([...input.room.walls, ...input.room.floors].map((s) => s.id));
  const seen = new Set<string>();
  for (const [index, sample] of (input.surfaceObservations ?? []).entries()) {
    const key = `${sample.surfaceId}:${sample.side}:${sample.photoIndex}`;
    if (!ids.has(sample.surfaceId) || sample.photoIndex >= input.photos.length || seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["surfaceObservations", index], message: "Color evidence must uniquely reference a measured surface and supplied photo." });
    }
    seen.add(key);
  }
});
export type ReconstructionInput = z.infer<typeof reconstructionInputSchema>;

const finishSchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .describe(
      "Observed #RRGGBB color, or null when the surface is not visible. Never the string unknown.",
    ),
  material: materialKindSchema,
  detail: materialDetailSchema.nullable().optional(),
});
export const surfaceFinishSchema = finishSchema.extend({
  surfaceId: z.string().min(1).max(160),
  regions: z
    .array(
      finishSchema.extend({
        // Local surface XY coordinates in meters. Renderer clips these to the measured
        // outline AND its openings; appearance can never create new room geometry.
        polygon: z
          .array(z.object({ x: coordinate, y: coordinate }))
          .min(3)
          .max(32),
        side: z.enum(["front", "back", "both"]),
      }),
    )
    .max(16)
    .nullable()
    .optional(),
});
// Visual bounds may include attached details omitted from the scanner's box.
// Scale/offset are relative to the unchanged measured object, before its rotation.
export const renderBoundsSchema = z.object({
  scale: z.object({
    x: z.number().min(1).max(8),
    y: z.number().min(1).max(8),
    z: z.number().min(1).max(8),
  }),
  offset: z.object({
    x: z.number().min(-4).max(4),
    y: z.number().min(-4).max(4),
    z: z.number().min(-4).max(4),
  }),
});
export const discoveredObjectSchema = z.object({
  objectId: z.string().regex(/^photo-[a-z0-9-]{1,80}$/),
  name: z.string().min(1).max(120),
  category: categorySchema,
  dimensions: dimensionsSchema,
  position: vectorSchema,
  rotation: vectorSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(500),
  photoIndices: z.array(z.number().int().min(0).max(15)).min(1).max(4),
});
export type DiscoveredObject = z.infer<typeof discoveredObjectSchema>;

/** Adds provenance when the supplying generation is known. */
export function discoveredRoomObject(
  object: DiscoveredObject,
  generation?: number,
): RoomObject {
  const baseline: RoomObject = {
    id: object.objectId,
    name: object.name,
    category: object.category,
    dimensions: object.dimensions,
    position: object.position,
    rotation: object.rotation,
    color: object.color,
    productId: null,
    assetId: null,
    owned: true,
    locked: false,
    measurementSource: "estimated",
    detectionSource: "photo",
    detectionConfidence:
      object.confidence >= 0.8
        ? "high"
        : object.confidence >= 0.5
          ? "medium"
          : "low",
  };
  // Copy the baseline: edits such as moves mutate vectors in place.
  return generation === undefined
    ? baseline
    : {
        ...baseline,
        discovery: { generation, baseline: structuredClone(baseline) },
      };
}

export const reconstructedObjectSchema = z
  .object({
    objectId: z.string().min(1).max(160),
    label: z.string().min(1).max(120),
    confidence: z.number().min(0).max(1),
    renderBounds: renderBoundsSchema.nullable().optional(),
    parts: z.array(parametricPartSchema).min(1).max(48),
  })
  .superRefine((object, ctx) => {
    if (
      new Set(object.parts.map((part) => part.id)).size !== object.parts.length
    )
      ctx.addIssue({ code: "custom", message: "Part IDs must be unique." });
    for (const [i, part] of object.parts.entries()) {
      const [x, y, z] = rotatedHalfExtents(part);
      if (
        Math.abs(part.position.x) + x > 0.500001 ||
        Math.abs(part.position.z) + z > 0.500001 ||
        part.position.y - y < -0.000001 ||
        part.position.y + y > 1.000001
      )
        ctx.addIssue({
          code: "custom",
          path: ["parts", i],
          message: "Geometry exceeds the measured furniture footprint.",
        });
    }
  });
export const reconstructedSceneSchema = z
  .object({
    version: z.literal(1),
    model: z.literal(RECONSTRUCTION_MODEL),
    roomId: z.string(),
    surfaces: z.array(surfaceFinishSchema).max(430),
    objects: z.array(reconstructedObjectSchema).max(144),
    discoveredObjects: z.array(discoveredObjectSchema).max(48).optional(),
    notes: z.array(z.string().max(240)).max(12),
  })
  .superRefine((scene, ctx) => {
    if (
      new Set(scene.objects.map((o) => o.objectId)).size !==
        scene.objects.length ||
      new Set(scene.surfaces.map((s) => s.surfaceId)).size !==
        scene.surfaces.length
    )
      ctx.addIssue({ code: "custom", message: "Scene IDs must be unique." });
    if (
      scene.objects.reduce((sum, object) => sum + object.parts.length, 0) > 2000
    )
      ctx.addIssue({
        code: "custom",
        message: "The reconstructed room exceeds the geometry budget.",
      });
  });
export type ReconstructedScene = z.infer<typeof reconstructedSceneSchema>;
export type ReconstructedObject = z.infer<typeof reconstructedObjectSchema>;
export type SurfaceFinish = z.infer<typeof surfaceFinishSchema>;

export function validateSceneForRoom(
  value: unknown,
  room: CapturedRoom,
): ReconstructedScene {
  const scene = reconstructedSceneSchema.parse(value);
  const discoveries = scene.discoveredObjects ?? [];
  validateDiscoveredObjects(discoveries, room);
  const allObjects = [
    ...room.objects,
    ...discoveries.map(discoveredRoomObject),
  ];
  const ids = new Set(allObjects.map((object) => object.id));
  for (const object of scene.objects) {
    const source = allObjects.find((item) => item.id === object.objectId);
    if (!source || !object.renderBounds) continue;
    const { scale, offset } = object.renderBounds;
    const dimensions = [
      source.dimensions.width,
      source.dimensions.height,
      source.dimensions.depth,
    ];
    for (const [i, axis] of (["x", "y", "z"] as const).entries()) {
      const baseMin = axis === "y" ? 0 : -0.5;
      const baseMax = axis === "y" ? 1 : 0.5;
      const min = offset[axis] + baseMin * scale[axis];
      const max = offset[axis] + baseMax * scale[axis];
      if (
        min > baseMin + 1e-6 ||
        max < baseMax - 1e-6 ||
        (baseMin - min) * dimensions[i] > 2 ||
        (max - baseMax) * dimensions[i] > 2
      )
        throw new Error(
          "Visual bounds must contain the scanned object and extend at most two meters per side.",
        );
    }
  }
  const surfaces = new Set(
    [...room.walls, ...room.floors, ...room.openings].map((s) => s.id),
  );
  if (
    scene.roomId !== room.id ||
    scene.objects.length !== ids.size ||
    scene.objects.some((object) => !ids.has(object.objectId)) ||
    scene.surfaces.some((surface) => !surfaces.has(surface.surfaceId))
  )
    throw new Error(
      "The reconstructed scene does not match the captured room.",
    );
  if (
    new TextEncoder().encode(JSON.stringify(scene)).byteLength > MAX_SCENE_BYTES
  )
    throw new Error("The reconstructed scene is too large.");
  return clearEmbeddedDecor(scene);
}

/** Reject ID collisions and implausible placement before spending calls on modeling. */
export function validateDiscoveredObjects(
  objects: DiscoveredObject[],
  room: CapturedRoom,
  photoCount = 16,
) {
  const ids = new Set(
    [...room.objects, ...room.walls, ...room.floors, ...room.openings].map(
      (o) => o.id,
    ),
  );
  for (const object of objects) {
    if (ids.has(object.objectId))
      throw new Error(
        "Discovered object IDs must be unique and distinct from scan IDs.",
      );
    ids.add(object.objectId);
    if (object.photoIndices.some((index) => index >= photoCount))
      throw new Error("Discovered objects must reference supplied photos.");
    const { width, height, depth } = object.dimensions;
    const half = rotatedHalfExtents({
      shape: "box",
      size: { x: width, y: height, z: depth },
      rotation: object.rotation,
      id: "bounds",
      name: "bounds",
      position: object.position,
      color: object.color,
      material: "matte",
    });
    // Position is the rotated local base center, including for wall-mounted items.
    const { x: rx, y: ry, z: rz } = object.rotation;
    const center = [
      object.position.x - (Math.cos(ry) * Math.sin(rz) * height) / 2,
      object.position.y +
        ((Math.cos(rx) * Math.cos(rz) -
          Math.sin(rx) * Math.sin(ry) * Math.sin(rz)) *
          height) /
          2,
      object.position.z +
        ((Math.sin(rx) * Math.cos(rz) +
          Math.cos(rx) * Math.sin(ry) * Math.sin(rz)) *
          height) /
          2,
    ];
    const limits = [
      room.dimensions.width,
      room.dimensions.height,
      room.dimensions.depth,
    ];
    if (
      center.some(
        (value, i) =>
          value - half[i] < -0.25 || value + half[i] > limits[i] + 0.25,
      )
    )
      throw new Error(
        "Discovered object geometry must fit within the captured room bounds.",
      );
  }
}

// Key order and absent optional fields do not count as edits.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const entries = (value: object) =>
    Object.entries(value).filter(([, item]) => item !== undefined);
  const left = entries(a);
  const right = new Map(entries(b));
  return (
    left.length === right.size &&
    left.every(
      ([key, item]) => right.has(key) && sameValue(item, right.get(key)),
    )
  );
}

/** The object without cleanup bookkeeping, e.g. for model context. */
export function withoutProvenance(object: RoomObject): RoomObject {
  const copy = { ...object };
  delete copy.discovery;
  return copy;
}

/** True when a discovery is exactly as its generation supplied it. */
export function discoveryUnedited(object: RoomObject) {
  if (!object.discovery) return false;
  const { discovery, ...fields } = object;
  return sameValue(fields, discovery.baseline);
}

type DiscoveryCommand = Extract<
  DesignCommand,
  { type: "discover" | "retire" | "generation" }
>;
const emptyRecord: ReconstructionRecord = {
  applied: [],
  retired: [],
  deleted: [],
};
const including = (ids: string[], id: string) =>
  ids.includes(id) ? ids : [...ids, id];

/** The room's bookkeeping, plus discovery IDs earlier versions saved beside it. */
function discoveryRecord(
  room: RoomSnapshot,
  legacyIds: string[] = [],
): ReconstructionRecord {
  const record = room.reconstruction ?? emptyRecord;
  return legacyIds.length
    ? { ...record, applied: [...new Set([...record.applied, ...legacyIds])] }
    : record;
}

/**
 * Whether a newer generation may remove this object automatically: an
 * unprotected photo discovery from an older generation, exactly as supplied.
 * An object retired before and present again was restored by an undo; keep it.
 */
function retirable(
  room: RoomSnapshot,
  object: RoomObject,
  generation: number,
) {
  return (
    object.detectionSource === "photo" &&
    object.owned &&
    !object.productId &&
    !object.assetId &&
    !object.locked &&
    !object.productLocked &&
    object.measurementSource !== "confirmed" &&
    !room.objects.some((item) => item.supportId === object.id) &&
    object.discovery !== undefined &&
    object.discovery.generation < generation &&
    discoveryUnedited(object) &&
    !room.reconstruction?.retired.some((entry) => entry.id === object.id)
  );
}

/**
 * Applies a reconstruction command to a room being edited, updating its
 * bookkeeping in the same step so both always commit together.
 */
export function applyDiscoveryCommand(
  room: RoomSnapshot,
  command: DiscoveryCommand,
) {
  const record = room.reconstruction ?? emptyRecord;
  const generation =
    command.type === "discover"
      ? command.object.discovery?.generation
      : command.generation;
  if (
    generation !== undefined &&
    record.generation !== undefined &&
    generation < record.generation
  )
    throw new Error("A newer reconstruction already updated this room.");
  const newest =
    generation === undefined
      ? record.generation
      : Math.max(record.generation ?? generation, generation);
  if (command.type === "generation") {
    room.reconstruction = { ...record, generation: newest };
    return;
  }
  if (command.type === "discover") {
    const { object } = command;
    if (
      !object.owned ||
      object.productId ||
      object.detectionSource !== "photo"
    )
      throw new Error("Only captured possessions can be imported this way.");
    if (room.objects.some((item) => item.id === object.id)) return;
    const retiredBy = record.retired.find(
      (entry) => entry.id === object.id,
    )?.generation;
    if (
      record.deleted.includes(object.id) ||
      (record.applied.includes(object.id) &&
        (retiredBy === undefined ||
          generation === undefined ||
          retiredBy >= generation))
    )
      throw new Error(
        `${object.name} was removed from this room and will not be added again.`,
      );
    room.objects.push(object);
    room.reconstruction = {
      generation: newest,
      applied: including(record.applied, object.id),
      retired: record.retired.filter((entry) => entry.id !== object.id),
      deleted: record.deleted,
    };
    return;
  }
  const object = room.objects.find((item) => item.id === command.objectId);
  if (!object) throw new Error("This item was removed. Select another item.");
  if (!retirable(room, object, command.generation))
    throw new Error(`${object.name} was edited or kept, so it stays.`);
  room.objects = room.objects.filter((item) => item.id !== object.id);
  room.reconstruction = {
    generation: newest,
    applied: including(record.applied, object.id),
    retired: [
      ...record.retired.filter((entry) => entry.id !== object.id),
      { id: object.id, generation: command.generation },
    ],
    deleted: record.deleted.filter((id) => id !== object.id),
  };
}

/** Records a photo discovery removed by an edit; no reconstruction restores it. */
export function recordDiscoveryRemoval(room: RoomSnapshot, object: RoomObject) {
  if (object.detectionSource !== "photo") return;
  const record = room.reconstruction ?? emptyRecord;
  room.reconstruction = {
    ...record,
    applied: including(record.applied, object.id),
    retired: record.retired.filter((entry) => entry.id !== object.id),
    deleted: including(record.deleted, object.id),
  };
}

/**
 * Plans the commands that bring the room's photo discoveries up to a scene.
 * Without a generation, only never-applied discoveries are added. With one, a
 * newer generation also retires unedited discoveries it no longer models and
 * restores discoveries an older generation retired. An older generation
 * changes nothing. Removed discoveries never return. `legacyIds` are applied
 * IDs that earlier versions saved beside the room.
 */
export function planDiscoveredObjects(
  room: CapturedRoom,
  scene: ReconstructedScene,
  legacyIds: string[] = [],
  generation?: number,
): { stale: boolean; commands: DiscoveryCommand[] } {
  if (room.id !== scene.roomId)
    throw new Error("Reconstruction belongs to another room.");
  const record = discoveryRecord(room, legacyIds);
  if (
    generation !== undefined &&
    record.generation !== undefined &&
    generation < record.generation
  )
    return { stale: true, commands: [] };
  const present = new Set(room.objects.map((object) => object.id));
  const applied = new Set(record.applied);
  const retired = new Map(
    record.retired.map((entry) => [entry.id, entry.generation]),
  );
  // Applied discoveries that vanished without retirement were removed by an
  // edit or undo, including those earlier versions did not record.
  const deleted = new Set([
    ...record.deleted,
    ...record.applied.filter((id) => !present.has(id) && !retired.has(id)),
  ]);
  const modeled = new Set([
    ...scene.objects.map((object) => object.objectId),
    ...(scene.discoveredObjects ?? []).map((object) => object.objectId),
  ]);
  const commands: DiscoveryCommand[] = [];
  if (generation !== undefined)
    for (const object of room.objects)
      if (
        applied.has(object.id) &&
        !modeled.has(object.id) &&
        retirable(room, object, generation)
      )
        commands.push({ type: "retire", objectId: object.id, generation });
  for (const object of scene.discoveredObjects ?? []) {
    const id = object.objectId;
    if (present.has(id) || deleted.has(id)) continue;
    const retiredBy = retired.get(id);
    if (
      !applied.has(id) ||
      (generation !== undefined &&
        retiredBy !== undefined &&
        retiredBy < generation)
    )
      commands.push({
        type: "discover",
        object: discoveredRoomObject(object, generation),
      });
  }
  if (
    !commands.length &&
    generation !== undefined &&
    (record.generation === undefined || generation > record.generation)
  )
    commands.push({ type: "generation", generation });
  return { stale: false, commands };
}

/** Applies a whole plan at once, for rooms edited only in this browser. */
export function mergeDiscoveredObjects(
  room: CapturedRoom,
  scene: ReconstructedScene,
  legacyIds: string[] = [],
  generation?: number,
) {
  const { stale, commands } = planDiscoveredObjects(
    room,
    scene,
    legacyIds,
    generation,
  );
  const removedObjectIds = commands.flatMap((command) =>
    command.type === "retire" ? [command.objectId] : [],
  );
  if (!commands.length) return { room, stale, removedObjectIds };
  const next = structuredClone(room);
  for (const command of commands) applyDiscoveryCommand(next, command);
  return {
    room: { ...next, revision: room.revision + 1 },
    stale,
    removedObjectIds,
  };
}
