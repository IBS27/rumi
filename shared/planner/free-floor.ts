import {
  rectangleRing,
  ringInside,
  ringsOverlap,
  regionContains,
  subtractRings,
  type Point2,
  type Region,
  type Ring,
  type SpaceModel,
} from "./space";

// Adapted from PR #34: measured free-floor rectangles give the model context.
// These areas are advisory, never one-piece reservations. Multiple pieces may
// share one area; reserveZones validates their actual bodies and clearances.

export interface FloorArea {
  id: string;
  center: Point2;
  // Width runs along the wall the area sits against; depth runs into the room.
  width: number;
  depth: number;
  // Facing: the piece's front points this way, away from the back wall.
  rotationY: number;
  wallId: string | null;
  // The back wall has a window within the area's span.
  window: boolean;
  // Existing objects within reach of the area, nearest first.
  near: string[];
}

export interface FloorAreaOptions {
  count: number;
  // Rectangles with a side under this are slivers nothing useful fits in.
  minSide: number;
  cell: number;
  // Floor left between a area and what surrounds it.
  gap: number;
}

export const AREA_DEFAULTS: FloorAreaOptions = {
  count: 3,
  minSide: 0.5,
  cell: 0.05,
  gap: 0.05,
};

// Objects whose underside is above this hang on a wall or ceiling and leave
// the floor beneath them free.
const OVERHEAD_BOTTOM = 0.9;

type Frame = { theta: number; c: number; s: number };

// World <-> frame, where the frame's +v axis is the facing direction of a
// piece rotated by theta (matching rectangleRing).
function toFrame(point: Point2, frame: Frame): { u: number; v: number } {
  return {
    u: point.x * frame.c - point.z * frame.s,
    v: point.x * frame.s + point.z * frame.c,
  };
}
function toWorld(u: number, v: number, frame: Frame): Point2 {
  return { x: u * frame.c + v * frame.s, z: -u * frame.s + v * frame.c };
}

interface FrameRectangle {
  frame: Frame;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  area: number;
}

// Largest empty axis-aligned rectangle in a rasterised free region: the
// classic histogram-of-free-cells sweep, O(cells).
function largestRectangle(
  free: Region[],
  frame: Frame,
  options: FloorAreaOptions,
): FrameRectangle | null {
  const points = free.flatMap((region) => region.flatMap((ring) => ring));
  if (points.length === 0) return null;
  const framed = points.map((point) => toFrame(point, frame));
  const uMin = Math.min(...framed.map((p) => p.u));
  const uMax = Math.max(...framed.map((p) => p.u));
  const vMin = Math.min(...framed.map((p) => p.v));
  const vMax = Math.max(...framed.map((p) => p.v));
  const cols = Math.ceil((uMax - uMin) / options.cell);
  const rows = Math.ceil((vMax - vMin) / options.cell);
  if (cols <= 0 || rows <= 0) return null;
  const heights = new Array<number>(cols).fill(0);
  let best: FrameRectangle | null = null;
  const minCells = Math.ceil(options.minSide / options.cell);
  for (let row = 0; row < rows; row++) {
    const v = vMin + (row + 0.5) * options.cell;
    for (let col = 0; col < cols; col++) {
      const u = uMin + (col + 0.5) * options.cell;
      const world = toWorld(u, v, frame);
      const inside = free.some((region) => regionContains(region, world));
      heights[col] = inside ? heights[col] + 1 : 0;
    }
    // Largest rectangle under the histogram, with a stack of rising columns.
    const stack: number[] = [];
    for (let col = 0; col <= cols; col++) {
      const height = col < cols ? heights[col] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= height) {
        const top = stack.pop()!;
        const h = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const w = col - left;
        if (h < minCells || w < minCells) continue;
        const area = h * w;
        if (!best || area > best.area)
          best = {
            frame,
            u0: uMin + left * options.cell,
            u1: uMin + col * options.cell,
            v0: vMin + (row + 1 - h) * options.cell,
            v1: vMin + (row + 1) * options.cell,
            area,
          };
      }
      stack.push(col);
    }
  }
  return best;
}

function distanceToSegment(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2
    ? Math.max(
        0,
        Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2),
      )
    : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function ringDistance(a: Ring, b: Ring): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      best = Math.min(
        best,
        distanceToSegment(a[i], b[j], b[(j + 1) % b.length]),
        distanceToSegment(b[j], a[i], a[(i + 1) % a.length]),
      );
    }
  return best;
}

// Unique facing directions worth trying: the inward normal of every wall.
function frames(model: SpaceModel, floorCenter: Point2): Frame[] {
  const seen = new Set<number>();
  const result: Frame[] = [];
  for (const wall of model.walls) {
    const dx = wall.end.x - wall.start.x,
      dz = wall.end.z - wall.start.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) continue;
    let nx = -dz / length,
      nz = dx / length;
    const mid = {
      x: (wall.start.x + wall.end.x) / 2,
      z: (wall.start.z + wall.end.z) / 2,
    };
    if ((floorCenter.x - mid.x) * nx + (floorCenter.z - mid.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // Rectangles are symmetric under a quarter turn, so fold to [0, 90°).
    const theta = Math.atan2(nx, nz);
    const key = Math.round(
      (((theta % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) * 36,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ theta, c: Math.cos(theta), s: Math.sin(theta) });
  }
  if (result.length === 0) result.push({ theta: 0, c: 1, s: 0 });
  return result;
}

export function findFreeFloorAreas(
  model: SpaceModel,
  options: Partial<FloorAreaOptions> = {},
): FloorArea[] {
  const settings = { ...AREA_DEFAULTS, ...options };
  if (!model.floor[0]?.length) return [];
  // Bound raster work for unusually large scans while retaining 5 cm detail
  // in ordinary rooms. Round inward only when describing measurements.
  const points = model.floor.flat();
  const span = Math.hypot(
    Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)),
    Math.max(...points.map((p) => p.z)) - Math.min(...points.map((p) => p.z)),
  );
  settings.cell = Math.max(settings.cell, span / 200);
  const floorCenter = model.floor[0].reduce(
    (sum, point) => ({
      x: sum.x + point.x / model.floor[0].length,
      z: sum.z + point.z / model.floor[0].length,
    }),
    { x: 0, z: 0 },
  );
  // Floor minus everything that stands on it (rugs and overhead pieces do not)
  // minus the strips doors need.
  const blocked = [
    ...model.obstacles
      .filter(
        (obstacle) =>
          obstacle.category !== "rug" &&
          obstacle.bottom <= model.floorY + OVERHEAD_BOTTOM,
      )
      .map((obstacle) => obstacle.footprint),
    ...model.clearances.map((zone) => zone.footprint),
  ];
  const taken: Ring[] = [];
  // Recomputed from the floor each round so holes (furniture inside the
  // free area) survive; subtracting from an outer ring alone would lose them.
  let free = subtractRings(model.floor, blocked);
  const orientations = frames(model, floorCenter);
  const areas: FloorArea[] = [];
  for (let index = 0; index < settings.count && free.length; index++) {
    let best: FrameRectangle | null = null;
    for (const frame of orientations) {
      const candidate = largestRectangle(free, frame, settings);
      if (candidate && (!best || candidate.area > best.area)) best = candidate;
    }
    if (!best) break;
    // Cells are judged by their centre, so a rectangle may poke half a cell
    // past the boundary; pull it in by that much.
    const inset = settings.cell / 2;
    const area = describe(
      {
        ...best,
        u0: best.u0 + inset,
        u1: best.u1 - inset,
        v0: best.v0 + inset,
        v1: best.v1 - inset,
      },
      model,
      `area-${index + 1}`,
    );
    const ring = rectangleRing(
      area.center,
      area.width,
      area.depth,
      area.rotationY,
    );
    // Centre-sampled raster cells can miss a thin obstacle or an angled edge.
    // Never describe such a rectangle as free space. Exact placement remains
    // independent of these advisory measurements.
    if (
      area.width >= settings.minSide &&
      area.depth >= settings.minSide &&
      ringInside(ring, model.floor) &&
      !blocked.some((block) => ringsOverlap(ring, block))
    )
      areas.push(area);
    // Leave a gap so the next area does not touch this one.
    taken.push(
      rectangleRing(
        area.center,
        area.width + 2 * settings.gap,
        area.depth + 2 * settings.gap,
        area.rotationY,
      ),
    );
    free = subtractRings(model.floor, [...blocked, ...taken]);
  }
  return areas;
}

// Turn a frame rectangle into a area: which edge rests on a wall decides the
// facing; the wall decides the window; nearby objects give the model context.
function describe(
  rect: FrameRectangle,
  model: SpaceModel,
  id: string,
): FloorArea {
  const { frame } = rect;
  const uMid = (rect.u0 + rect.u1) / 2,
    vMid = (rect.v0 + rect.v1) / 2;
  const center = toWorld(uMid, vMid, frame);
  const edges: { mid: Point2; facing: Point2; along: "u" | "v" }[] = [
    {
      mid: toWorld(uMid, rect.v0, frame),
      facing: toWorld(0, 1, frame),
      along: "u",
    },
    {
      mid: toWorld(uMid, rect.v1, frame),
      facing: toWorld(0, -1, frame),
      along: "u",
    },
    {
      mid: toWorld(rect.u0, vMid, frame),
      facing: toWorld(1, 0, frame),
      along: "v",
    },
    {
      mid: toWorld(rect.u1, vMid, frame),
      facing: toWorld(-1, 0, frame),
      along: "v",
    },
  ];
  let back: {
    edge: (typeof edges)[number];
    wallId: string;
    distance: number;
  } | null = null;
  for (const edge of edges)
    for (const wall of model.walls) {
      const distance = distanceToSegment(edge.mid, wall.start, wall.end);
      const dx = wall.end.x - wall.start.x,
        dz = wall.end.z - wall.start.z;
      const length = Math.hypot(dx, dz);
      const parallel =
        length > 0 &&
        Math.abs((edge.facing.x * dx + edge.facing.z * dz) / length) < 0.05;
      if (parallel && distance <= 0.25 && (!back || distance < back.distance))
        back = { edge, wallId: wall.id, distance };
    }
  const edge = back?.edge ?? edges[0];
  const rotationY = Math.atan2(edge.facing.x, edge.facing.z) + 0;
  const uSize = rect.u1 - rect.u0,
    vSize = rect.v1 - rect.v0;
  const width = edge.along === "u" ? uSize : vSize;
  const depth = edge.along === "u" ? vSize : uSize;
  const ring = rectangleRing(center, width, depth, rotationY);
  const wall = back
    ? model.walls.find((item) => item.id === back!.wallId)
    : undefined;
  const window = Boolean(
    wall?.openings.some(
      (opening) =>
        opening.kind === "window" &&
        distanceToSegment(opening.start, ring[0], ring[1]) < width &&
        Math.min(
          distanceToSegment(opening.start, edge.mid, edge.mid),
          distanceToSegment(opening.end, edge.mid, edge.mid),
        ) <=
          width / 2 + 0.3,
    ),
  );
  const near = model.obstacles
    .filter(
      (obstacle) =>
        obstacle.category !== "rug" &&
        obstacle.bottom <= model.floorY + OVERHEAD_BOTTOM,
    )
    .map((obstacle) => ({
      name: obstacle.name,
      distance: ringDistance(ring, obstacle.footprint),
    }))
    .filter((item) => item.distance <= 0.6)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.name);
  return {
    id,
    center,
    width,
    depth,
    rotationY,
    wallId: back?.wallId ?? null,
    window,
    near,
  };
}

export function describeFreeFloorAreas(areas: FloorArea[]): string {
  if (areas.length === 0)
    return "No large free-floor rectangle was identified. Narrower or irregular placements may still fit; code checks them.";
  return areas
    .map((area, index) => {
      const where = area.wallId
        ? `against a wall${area.window ? " with a window" : ""}`
        : "in open floor";
      const near = area.near.length ? `, next to ${area.near.join(", ")}` : "";
      const meters = (value: number) =>
        (Math.floor(value * 100) / 100).toFixed(2);
      return `Area ${index + 1}: ${meters(area.width)} m wide × ${meters(area.depth)} m deep, ${where}${near}.`;
    })
    .join("\n");
}
