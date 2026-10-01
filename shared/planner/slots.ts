import type { RoomSnapshot } from "../contracts";
import type { PlanScope } from "./scope";
import {
  rectangleRing,
  regionContains,
  ringInside,
  ringsOverlap,
  subtractRings,
  unionRings,
  type Point2,
  type Region,
  type Ring,
  type SpaceModel,
} from "./space";

// Space-first planning: before asking what furniture the room needs, find
// where furniture can go. A slot is an empty rectangle of floor, aligned to a
// wall so a piece can stand against it. The planner may give each slot to one
// floor piece; reserveZones then keeps that piece inside it.

export interface Slot {
  id: string;
  center: Point2;
  // Width runs along the wall the slot sits against; depth runs into the room.
  width: number;
  depth: number;
  // Facing: the piece's front points this way, away from the back wall.
  rotationY: number;
  wallId: string | null;
  // The back wall has a window within the slot's span.
  window: boolean;
  // Existing objects within reach of the slot, nearest first.
  near: string[];
}

export interface SlotOptions {
  count: number;
  // Rectangles with a side under this are slivers nothing useful fits in.
  minSide: number;
  cell: number;
  // Floor left between a slot and what surrounds it.
  gap: number;
  // A slot is where one piece stands against a wall. Larger open floor is
  // split so several pieces can each have one: no piece needs more depth than
  // a king bed frame, or more wall than a large sofa.
  maxWidth: number;
  maxDepth: number;
}

export const SLOT_DEFAULTS: SlotOptions = {
  count: 3,
  minSide: 0.5,
  cell: 0.05,
  gap: 0.05,
  maxWidth: 3.2,
  maxDepth: 2.4,
};

// The rules the planner model follows for slots. Pieces beyond the listed
// slots take slotId null, so any number of floor pieces, or none, is valid.
export const SLOT_RULES =
  "Code has measured the free floor and lists it below as slots: empty rectangles, largest first, most against a wall. A floor piece may take one slot: set slotId to that slot's id and keep its footprint within the slot's width and depth, allowing for its back clearance. Code then places it inside that slot or rejects it; it never moves it elsewhere. A slot holds at most one piece. When no listed slot suits a floor piece, or there are more floor pieces than slots, set that piece's slotId null and code places it in the remaining free floor. Wall, surface and under pieces never take a slot; set their slotId null. The number of slots never limits the number of pieces. Match pieces to slots: a bed to a deep slot, a desk to a slot under a window, a chair or plant to a small one.";

// Objects whose underside is above this hang on a wall or ceiling and leave
// the floor beneath them free.
const OVERHEAD_BOTTOM = 0.9;
// Final rectangles stay this far from every edge, so touching or rounding
// never reads as overlap.
const EDGE_CLEARANCE = 0.005;

type Frame = { theta: number; c: number; s: number };
type FramePoint = { u: number; v: number };

// World <-> frame, where the frame's +v axis is the facing direction of a
// piece rotated by theta (matching rectangleRing).
function toFrame(point: Point2, frame: Frame): FramePoint {
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

// Whether segment a-b passes through the open box, by Liang-Barsky clipping.
function crossesBox(
  a: FramePoint,
  b: FramePoint,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): boolean {
  let t0 = 0,
    t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      t0 = Math.max(t0, r);
    } else {
      if (r < t0) return false;
      t1 = Math.min(t1, r);
    }
    return true;
  };
  const du = b.u - a.u,
    dv = b.v - a.v;
  return (
    clip(-du, a.u - u0) &&
    clip(du, u1 - a.u) &&
    clip(-dv, a.v - v0) &&
    clip(dv, v1 - a.v) &&
    t0 < t1
  );
}

// Largest empty axis-aligned rectangle in a rasterised free region: the
// classic histogram-of-free-cells sweep. A cell counts as free only when all
// of it is: its centre is inside the region and no region edge crosses it, so
// a thin divider or an angled wall between cell centres still blocks it.
function largestRectangle(
  free: Region[],
  frame: Frame,
  options: SlotOptions,
): FrameRectangle | null {
  const rings = free.flat();
  const points = rings.flat();
  if (points.length === 0) return null;
  const framed = points.map((point) => toFrame(point, frame));
  const uMin = Math.min(...framed.map((p) => p.u));
  const uMax = Math.max(...framed.map((p) => p.u));
  const vMin = Math.min(...framed.map((p) => p.v));
  const vMax = Math.max(...framed.map((p) => p.v));
  const { cell } = options;
  const cols = Math.ceil((uMax - uMin) / cell);
  const rows = Math.ceil((vMax - vMin) / cell);
  if (cols <= 0 || rows <= 0) return null;
  const cells = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const world = toWorld(uMin + (col + 0.5) * cell, vMin + (row + 0.5) * cell, frame);
      if (free.some((region) => regionContains(region, world))) cells[row * cols + col] = 1;
    }
  // Edges lying on a cell border do not cross it; this keeps whole cells
  // along an axis-aligned wall.
  const inset = 1e-7;
  const index = (value: number, min: number, count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((value - min) / cell)));
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = toFrame(ring[i], frame);
      const b = toFrame(ring[(i + 1) % ring.length], frame);
      const c0 = index(Math.min(a.u, b.u), uMin, cols),
        c1 = index(Math.max(a.u, b.u), uMin, cols);
      const r0 = index(Math.min(a.v, b.v), vMin, rows),
        r1 = index(Math.max(a.v, b.v), vMin, rows);
      for (let row = r0; row <= r1; row++)
        for (let col = c0; col <= c1; col++) {
          const at = row * cols + col;
          if (!cells[at]) continue;
          const u0 = uMin + col * cell,
            v0 = vMin + row * cell;
          if (crossesBox(a, b, u0 + inset, u0 + cell - inset, v0 + inset, v0 + cell - inset))
            cells[at] = 0;
        }
    }
  const heights = new Array<number>(cols).fill(0);
  let best: FrameRectangle | null = null;
  const minCells = Math.ceil(options.minSide / cell - 1e-9);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++)
      heights[col] = cells[row * cols + col] ? heights[col] + 1 : 0;
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
            u0: uMin + left * cell,
            u1: uMin + col * cell,
            v0: vMin + (row + 1 - h) * cell,
            v1: vMin + (row + 1) * cell,
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
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2))
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
    const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };
    if ((floorCenter.x - mid.x) * nx + (floorCenter.z - mid.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    // Rectangles are symmetric under a quarter turn, so fold to [0, 90°).
    const theta = Math.atan2(nx, nz);
    const key = Math.round((((theta % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) * 36);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ theta, c: Math.cos(theta), s: Math.sin(theta) });
  }
  if (result.length === 0) result.push({ theta: 0, c: 1, s: 0 });
  return result;
}

interface Edge {
  mid: Point2;
  facing: Point2;
  // The axis the edge runs along, and whether it is the low or high side of
  // the other axis.
  along: "u" | "v";
  low: boolean;
}

function edgesOf(rect: FrameRectangle): Edge[] {
  const { frame } = rect;
  const uMid = (rect.u0 + rect.u1) / 2,
    vMid = (rect.v0 + rect.v1) / 2;
  return [
    { mid: toWorld(uMid, rect.v0, frame), facing: toWorld(0, 1, frame), along: "u", low: true },
    { mid: toWorld(uMid, rect.v1, frame), facing: toWorld(0, -1, frame), along: "u", low: false },
    { mid: toWorld(rect.u0, vMid, frame), facing: toWorld(1, 0, frame), along: "v", low: true },
    { mid: toWorld(rect.u1, vMid, frame), facing: toWorld(-1, 0, frame), along: "v", low: false },
  ];
}

// The edge that rests on a wall parallel to it decides the facing.
function backEdge(rect: FrameRectangle, model: SpaceModel): { edge: Edge; wallId: string } | null {
  let back: { edge: Edge; wallId: string; distance: number } | null = null;
  for (const edge of edgesOf(rect))
    for (const wall of model.walls) {
      const distance = distanceToSegment(edge.mid, wall.start, wall.end);
      const dx = wall.end.x - wall.start.x,
        dz = wall.end.z - wall.start.z;
      const length = Math.hypot(dx, dz);
      const parallel =
        length > 0 && Math.abs((edge.facing.x * dx + edge.facing.z * dz) / length) < 0.05;
      if (parallel && distance <= 0.25 && (!back || distance < back.distance))
        back = { edge, wallId: wall.id, distance };
    }
  return back;
}

// Keep the back edge on its wall, cap the depth into the room and the width
// along the wall, and keep the end that sits in a corner. What is cut off
// stays free for the next slot.
function fitToWall(
  rect: FrameRectangle,
  back: { edge: Edge; wallId: string } | null,
  model: SpaceModel,
  options: SlotOptions,
): FrameRectangle {
  const edge = back?.edge ?? edgesOf(rect)[0];
  let { u0, u1, v0, v1 } = rect;
  if (edge.along === "u") {
    if (edge.low) v1 = Math.min(v1, v0 + options.maxDepth);
    else v0 = Math.max(v0, v1 - options.maxDepth);
  } else {
    if (edge.low) u1 = Math.min(u1, u0 + options.maxDepth);
    else u0 = Math.max(u0, u1 - options.maxDepth);
  }
  const cornered = (point: Point2) =>
    model.walls.some(
      (wall) => wall.id !== back?.wallId && distanceToSegment(point, wall.start, wall.end) <= 0.25,
    );
  if (edge.along === "u" && u1 - u0 > options.maxWidth) {
    const v = edge.low ? v0 : v1;
    if (cornered(toWorld(u0, v, rect.frame)) || !cornered(toWorld(u1, v, rect.frame)))
      u1 = u0 + options.maxWidth;
    else u0 = u1 - options.maxWidth;
  }
  if (edge.along === "v" && v1 - v0 > options.maxWidth) {
    const u = edge.low ? u0 : u1;
    if (cornered(toWorld(u, v0, rect.frame)) || !cornered(toWorld(u, v1, rect.frame)))
      v1 = v0 + options.maxWidth;
    else v0 = v1 - options.maxWidth;
  }
  return { frame: rect.frame, u0, u1, v0, v1, area: (u1 - u0) * (v1 - v0) };
}

export function slotRing(slot: Pick<Slot, "center" | "width" | "depth" | "rotationY">): Ring {
  return rectangleRing(slot.center, slot.width, slot.depth, slot.rotationY);
}

export function findSlots(model: SpaceModel, options: Partial<SlotOptions> = {}): Slot[] {
  const settings = { ...SLOT_DEFAULTS, ...options };
  if (!model.floor[0]?.length) return [];
  // Bound raster work for unusually large scans while keeping 5 cm detail in
  // ordinary rooms.
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
          obstacle.category !== "rug" && obstacle.bottom <= model.floorY + OVERHEAD_BOTTOM,
      )
      .map((obstacle) => obstacle.footprint),
    ...model.clearances.map((zone) => zone.footprint),
  ];
  const floor = unionRings(model.floor);
  const orientations = frames(model, floorCenter);
  const taken: Ring[] = [];
  const found: SlotShape[] = [];
  // A rectangle that fails the final check is set aside and the search goes
  // on; the attempt bound keeps a pathological scan from looping.
  for (let attempt = 0; found.length < settings.count && attempt < settings.count * 3; attempt++) {
    // Recomputed from the floor each round so holes (furniture inside the
    // free area) survive; subtracting from an outer ring alone would lose them.
    const free = subtractRings(model.floor, [...blocked, ...taken]);
    if (!free.length) break;
    let best: FrameRectangle | null = null;
    for (const frame of orientations) {
      const candidate = largestRectangle(free, frame, settings);
      if (candidate && (!best || candidate.area > best.area)) best = candidate;
    }
    if (!best) break;
    const back = backEdge(best, model);
    const slot = shape(fitToWall(best, back, model, settings), back);
    const ring = slotRing(slot);
    // Leave a gap so the next slot does not touch this one.
    taken.push(
      rectangleRing(slot.center, slot.width + 2 * settings.gap, slot.depth + 2 * settings.gap, slot.rotationY),
    );
    // Check the final, rounded rectangle against the exact geometry.
    if (
      slot.width >= settings.minSide &&
      slot.depth >= settings.minSide &&
      ringInside(ring, floor) &&
      !blocked.some((block) => ringsOverlap(ring, block)) &&
      !found.some((other) => ringsOverlap(ring, slotRing(other)))
    )
      found.push(slot);
  }
  return found
    .sort((a, b) => b.width * b.depth - a.width * a.depth)
    .map((slot, index) => ({ id: `slot-${index + 1}`, ...annotate(slot, model) }));
}

// The slots offered to the planner and used to reserve its plan: one for each
// floor piece the plan may keep, and none where the scan measured no floor.
export function planSlots(room: RoomSnapshot, model: SpaceModel, scope: PlanScope): Slot[] {
  if (room.shape === "polygon" && !room.floors.length) return [];
  return findSlots(model, { count: scope.maxZones });
}

type SlotShape = Pick<Slot, "center" | "width" | "depth" | "rotationY" | "wallId">;

// Turn a frame rectangle into a slot shape: the back edge decides the facing.
// Sizes are rounded down to the centimetre inside a small edge clearance.
function shape(rect: FrameRectangle, back: { edge: Edge; wallId: string } | null): SlotShape {
  const edges = edgesOf(rect);
  const edge = back
    ? edges.find((item) => item.along === back.edge.along && item.low === back.edge.low)!
    : edges[0];
  const uSize = rect.u1 - rect.u0,
    vSize = rect.v1 - rect.v0;
  const inward = (value: number) => Math.floor((value - 2 * EDGE_CLEARANCE) * 100) / 100;
  return {
    center: toWorld((rect.u0 + rect.u1) / 2, (rect.v0 + rect.v1) / 2, rect.frame),
    width: inward(edge.along === "u" ? uSize : vSize),
    depth: inward(edge.along === "u" ? vSize : uSize),
    rotationY: Math.atan2(edge.facing.x, edge.facing.z) + 0,
    wallId: back?.wallId ?? null,
  };
}

// What the model is told about a slot: whether its wall has a window, and
// which existing objects are within reach.
function annotate(slot: SlotShape, model: SpaceModel): Omit<Slot, "id"> {
  const ring = slotRing(slot);
  const back = {
    x: (ring[0].x + ring[1].x) / 2,
    z: (ring[0].z + ring[1].z) / 2,
  };
  const wall = model.walls.find((item) => item.id === slot.wallId);
  const window = Boolean(
    wall?.openings.some(
      (opening) =>
        opening.kind === "window" &&
        distanceToSegment(opening.start, ring[0], ring[1]) < slot.width &&
        Math.min(
          distanceToSegment(opening.start, back, back),
          distanceToSegment(opening.end, back, back),
        ) <=
          slot.width / 2 + 0.3,
    ),
  );
  const near = model.obstacles
    .filter(
      (obstacle) =>
        obstacle.category !== "rug" && obstacle.bottom <= model.floorY + OVERHEAD_BOTTOM,
    )
    .map((obstacle) => ({ name: obstacle.name, distance: ringDistance(ring, obstacle.footprint) }))
    .filter((item) => item.distance <= 0.6)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.name);
  return { ...slot, window, near };
}

export function describeSlots(slots: Slot[]): string {
  if (slots.length === 0)
    return "No free-floor rectangle of 0.5 m or more was found. Set slotId null for every piece; narrower placements may still fit, and code checks them.";
  return slots
    .map((slot, index) => {
      const where = slot.wallId
        ? `against a wall${slot.window ? " with a window" : ""}`
        : "in open floor";
      const near = slot.near.length ? `, next to ${slot.near.join(", ")}` : "";
      return `Slot ${index + 1} (${slot.id}): ${slot.width.toFixed(2)} m wide × ${slot.depth.toFixed(2)} m deep, ${where}${near}.`;
    })
    .join("\n");
}
