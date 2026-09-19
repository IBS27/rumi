import { z } from "zod";
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  categorySchema,
  roomSchema,
  type CapturedRoom,
  type CapturedSurface,
} from "../contracts";

export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const tuple = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const transform = z
  .array(z.number().finite())
  .length(16)
  .refine((m) => {
    const axes = [
      new Vector3(m[0], m[1], m[2]),
      new Vector3(m[4], m[5], m[6]),
      new Vector3(m[8], m[9], m[10]),
    ];
    return (
      axes.every((a) => Math.abs(a.length() - 1) < 0.01) &&
      Math.abs(axes[0].dot(axes[1])) < 0.01 &&
      Math.abs(axes[0].dot(axes[2])) < 0.01 &&
      Math.abs(axes[1].dot(axes[2])) < 0.01 &&
      axes[0].clone().cross(axes[1]).dot(axes[2]) > 0.99 &&
      Math.abs(m[3]) < 0.001 &&
      Math.abs(m[7]) < 0.001 &&
      Math.abs(m[11]) < 0.001 &&
      Math.abs(m[15] - 1) < 0.001
    );
  }, "Expected a rigid, right-handed RoomPlan transform");
const element = z
  .object({
    identifier: z.string().min(1),
    dimensions: tuple,
    transform,
    category: z.record(z.string(), z.unknown()),
    confidence: z.record(z.string(), z.unknown()).optional(),
    parentIdentifier: z.string().nullable().optional(),
    polygonCorners: z.array(tuple).max(512).optional(),
    curve: z.unknown().optional(),
  })
  .passthrough();
export const roomPlanSchema = z.object({
  version: z.number().finite().optional(),
  walls: z.array(element).min(1).max(200),
  floors: z.array(element).max(30).optional(),
  doors: z.array(element).max(100).optional(),
  windows: z.array(element).max(100).optional(),
  openings: z.array(element).max(100).optional(),
  objects: z.array(element).max(500),
});
type Element = z.infer<typeof element>;

export function localCorners(
  surface: Pick<CapturedSurface, "dimensions" | "polygonCorners">,
): Vector3[] {
  if (surface.polygonCorners.length >= 3)
    return surface.polygonCorners.map((p) => new Vector3(p.x, p.y, p.z));
  const { width: w, height: h } = surface.dimensions;
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => new Vector3(x, y, 0));
}

export function worldCorners(surface: CapturedSurface): Vector3[] {
  const matrix = new Matrix4().fromArray(surface.transform);
  return localCorners(surface).map((p) => p.applyMatrix4(matrix));
}

function confidence(value: Element): CapturedSurface["confidence"] {
  const key = Object.keys(value.confidence ?? {})[0];
  return key === "low" || key === "medium" || key === "high" ? key : "unknown";
}

function surface(
  value: Element,
  kind: CapturedSurface["kind"],
): CapturedSurface {
  const [width, height, depth] = value.dimensions;
  if (width <= 0 || height <= 0 || depth < 0)
    throw new Error(`Invalid dimensions for ${kind} ${value.identifier}.`);
  if (value.curve != null)
    throw new Error(
      "Curved surfaces are not supported yet. Keep the original export for a future importer.",
    );
  if (value.polygonCorners?.length && value.polygonCorners.length < 3)
    throw new Error("A surface polygon needs at least three corners.");
  return {
    id: value.identifier,
    kind,
    parentId: value.parentIdentifier ?? null,
    dimensions: { width, height, depth },
    transform: [...value.transform],
    polygonCorners: (value.polygonCorners ?? []).map(([x, y, z]) => ({
      x,
      y,
      z,
    })),
    confidence: confidence(value),
  };
}

export function importRoomPlan(
  input: unknown,
  name = "My scanned room",
  synthetic = false,
): CapturedRoom {
  const parsed = roomPlanSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `This is not a supported RoomPlan export: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
    );
  const raw = parsed.data;
  const all = [
    ...raw.walls,
    ...(raw.floors ?? []),
    ...(raw.doors ?? []),
    ...(raw.windows ?? []),
    ...(raw.openings ?? []),
    ...raw.objects,
  ];
  if (new Set(all.map((e) => e.identifier)).size !== all.length)
    throw new Error("The scan contains duplicate identifiers.");
  const walls = raw.walls.map((e) => surface(e, "wall"));
  const floors = (raw.floors ?? []).map((e) => surface(e, "floor"));
  const openings = [
    ...(raw.doors ?? []).map((e) => surface(e, "door")),
    ...(raw.windows ?? []).map((e) => surface(e, "window")),
    ...(raw.openings ?? []).map((e) => surface(e, "opening")),
  ];
  const points = [...walls, ...floors].flatMap(worldCorners);
  const bounds = new Box3().setFromPoints(points);
  const minX = bounds.min.x,
    minZ = bounds.min.z;
  const floorPoints = floors.flatMap(worldCorners);
  const floorBounds = new Box3().setFromPoints(
    floorPoints.length ? floorPoints : points,
  );
  const floorY = floorBounds.min.y;
  const origin = { x: minX, y: floorY, z: minZ };
  for (const s of [...walls, ...floors, ...openings]) {
    s.transform[12] -= minX;
    s.transform[13] -= floorY;
    s.transform[14] -= minZ;
  }
  const warnings: string[] = [
    "Scan dimensions are estimates. Verify measurements before checking furniture fit.",
  ];
  if (!floors.length)
    warnings.push(
      "This export has no floor polygon. Walls are shown without inventing a floor boundary.",
    );
  if (floorPoints.length && floorBounds.max.y - floorY > 0.1)
    warnings.push("The scan contains uneven or multiple floor elevations.");
  const wallIds = new Set(walls.map((w) => w.id));
  for (const opening of openings) {
    if (!opening.parentId || !wallIds.has(opening.parentId)) {
      // Match older RoomPlan exports geometrically, only when there is one clear wall.
      const center = new Vector3().setFromMatrixPosition(
        new Matrix4().fromArray(opening.transform),
      );
      const matches = walls.filter((wall) => {
        const p = center
          .clone()
          .applyMatrix4(new Matrix4().fromArray(wall.transform).invert());
        return (
          Math.abs(p.z) < 0.08 &&
          Math.abs(p.x) + opening.dimensions.width / 2 <=
            wall.dimensions.width / 2 + 0.08 &&
          Math.abs(p.y) < wall.dimensions.height / 2
        );
      });
      opening.parentId = matches.length === 1 ? matches[0].id : null;
      if (!opening.parentId)
        warnings.push(
          `An ${opening.kind} could not be linked to a wall; its outline is retained.`,
        );
    }
  }
  const counts = new Map<string, number>();
  const objects = raw.objects.map((value) => {
    const [width, height, depth] = value.dimensions;
    if (width <= 0 || height <= 0 || depth <= 0)
      throw new Error(`Invalid furniture dimensions for ${value.identifier}.`);
    const sourceCategory = Object.keys(value.category)[0] ?? "unknown";
    const mapping: Record<string, string> = {
      bed: "bed",
      sofa: "sofa",
      chair: "chair",
      table: "table",
      storage: "storage",
      refrigerator: "refrigerator",
      oven: "oven",
      sink: "sink",
      toilet: "toilet",
      bathtub: "bathtub",
      dishwasher: "dishwasher",
      washerDryer: "washerDryer",
      television: "television",
      fireplace: "fireplace",
      stairs: "stairs",
    };
    const category = categorySchema.parse(mapping[sourceCategory] ?? "unknown");
    const count = (counts.get(sourceCategory) ?? 0) + 1;
    counts.set(sourceCategory, count);
    const matrix = new Matrix4().fromArray(value.transform);
    const base = new Vector3(0, -height / 2, 0)
      .applyMatrix4(matrix)
      .sub(new Vector3(minX, floorY, minZ));
    const rotation = new Euler().setFromQuaternion(
      new Quaternion().setFromRotationMatrix(matrix),
      "XYZ",
    );
    return {
      id: value.identifier,
      name: `${sourceCategory.charAt(0).toUpperCase()}${sourceCategory.slice(1)} ${count}`,
      category,
      sourceCategory,
      assetId: null,
      productId: null,
      dimensions: { width, height, depth },
      position: { x: base.x, y: base.y, z: base.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
      color:
        category === "sofa"
          ? "#778879"
          : category === "storage"
            ? "#c19c79"
            : "#b7aea1",
      owned: true,
      locked: false,
      measurementSource: "estimated" as const,
      detectionConfidence: confidence(value),
    };
  });
  if (objects.some((o) => o.category === "unknown"))
    warnings.push(
      "Unrecognized furniture categories are retained as unknown objects.",
    );
  return roomSchema.parse({
    id: `scan-${walls[0].id}`,
    name,
    revision: 0,
    shape: "polygon",
    dimensions: {
      width: bounds.max.x - minX,
      height: bounds.max.y - floorY,
      depth: bounds.max.z - minZ,
    },
    measurementSource: "estimated",
    walls,
    floors,
    openings,
    objects,
    capture: {
      provider: "roomplan",
      version: raw.version ?? null,
      synthetic,
      origin,
      warnings,
    },
  }) as CapturedRoom;
}

export const savedRoomSchema = z
  .object({
    format: z.literal("rumi.room"),
    version: z.literal(1),
    room: roomSchema,
    original: roomPlanSchema.passthrough(),
  })
  .superRefine((value, ctx) => {
    try {
      importRoomPlan(value.original);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["original"],
        message: "The original scan is invalid.",
      });
    }
    if (value.room.shape !== "polygon") return;
    const surfaces = [
      ...value.room.walls,
      ...value.room.floors,
      ...value.room.openings,
    ];
    const ids = [...surfaces, ...value.room.objects].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["room"],
        message: "Scan identifiers must be unique.",
      });
    for (const item of surfaces) {
      if (
        !transform.safeParse(item.transform).success ||
        (item.polygonCorners.length > 0 && item.polygonCorners.length < 3)
      )
        ctx.addIssue({
          code: "custom",
          path: ["room"],
          message: "Invalid saved surface geometry.",
        });
    }
  });
export type SavedRoom = z.infer<typeof savedRoomSchema>;

export function parseRoomFile(text: string, name: string): SavedRoom {
  if (new TextEncoder().encode(text).byteLength > MAX_CAPTURE_BYTES)
    throw new Error("Choose a room JSON file smaller than 10 MB.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === "rumi.room"
  )
    return savedRoomSchema.parse(value);
  return {
    format: "rumi.room",
    version: 1,
    room: importRoomPlan(value, name.replace(/\.json$/i, "")),
    original: roomPlanSchema.passthrough().parse(value),
  };
}
