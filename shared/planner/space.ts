import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import polygonClipping, { type Polygon } from "polygon-clipping";
import type { CapturedSurface, RoomObject, RoomSnapshot } from "../contracts";
import { worldCorners } from "../capture/roomplan";

// Everything here is in meters on the renderer's floor plane: X runs across the
// room, Z runs into it, Y is up. Positions are base centers, like RoomObject.

export type Point2 = { x: number; z: number };
export type Ring = Point2[];
// A region is an outer ring followed by any hole rings, in polygon-clipping order.
export type Region = Ring[];

export interface WallSegment {
  id: string;
  start: Point2;
  end: Point2;
  height: number;
  openings: { kind: "door" | "window" | "opening"; start: Point2; end: Point2 }[];
}

export interface Obstacle3D {
  id: string;
  name: string;
  category: string;
  footprint: Ring;
  bottom: number;
  top: number;
  locked: boolean;
}

export interface ClearanceZone {
  id: string;
  kind: "door" | "path";
  footprint: Ring;
  reason: string;
}

export interface SpaceModel {
  units: "meters";
  shape: RoomSnapshot["shape"];
  bounds: { width: number; depth: number; height: number };
  floorY: number;
  floor: Ring[];
  walls: WallSegment[];
  obstacles: Obstacle3D[];
  clearances: ClearanceZone[];
  freeSpace: Region[];
  warnings: string[];
}

export const DOOR_CLEARANCE = 0.9;
export const WALK_PATH = 0.6;
export const FURNITURE_GAP = 0.2;

export function rectangleRing(
  center: Point2,
  width: number,
  depth: number,
  rotationY = 0,
): Ring {
  const c = Math.cos(rotationY),
    s = Math.sin(rotationY);
  return [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ].map(([x, z]) => ({
    x: center.x + x * c + z * s,
    z: center.z - x * s + z * c,
  }));
}

export function ringArea(ring: Ring): number {
  return (
    Math.abs(
      ring.reduce((sum, point, index) => {
        const next = ring[(index + 1) % ring.length];
        return sum + point.x * next.z - next.x * point.z;
      }, 0),
    ) / 2
  );
}

export function polygonArea(rings: Ring[]): number {
  return rings.reduce((sum, ring) => sum + ringArea(ring), 0);
}

function toClipping(rings: Ring[]): Polygon[] {
  return rings
    .filter((ring) => ring.length >= 3)
    .map((ring) => [ring.map((point) => [point.x, point.z] as [number, number])]);
}

function fromClipping(result: Polygon[]): Region[] {
  return result
    .map((polygon) =>
      polygon
        .map((ring) => ring.map(([x, z]) => ({ x, z })))
        .filter((ring) => ring.length >= 3),
    )
    .filter((region) => region.length > 0);
}

export function subtractRings(base: Ring[], cut: Ring[]): Region[] {
  const subject = toClipping(base);
  const clip = toClipping(cut);
  if (subject.length === 0) return [];
  if (clip.length === 0) return base.map((ring) => [ring]);
  try {
    return fromClipping(
      polygonClipping.difference(
        [subject[0], ...subject.slice(1)] as Parameters<
          typeof polygonClipping.difference
        >[0],
        ...(clip as Parameters<typeof polygonClipping.difference>),
      ),
    );
  } catch {
    return [];
  }
}

export function unionRings(rings: Ring[]): Ring[] {
  const polygons = toClipping(rings);
  if (polygons.length === 0) return [];
  try {
    return fromClipping(
      polygonClipping.union(polygons[0], ...polygons.slice(1)),
    ).map((region) => region[0]);
  } catch {
    return [];
  }
}

export function regionContains(region: Region, point: Point2): boolean {
  const [outer, ...holes] = region;
  return (
    ringContains(outer, point) &&
    !holes.some((hole) => ringContains(hole, point))
  );
}

export function freeSpaceContains(model: SpaceModel, point: Point2): boolean {
  return model.freeSpace.some((region) => regionContains(region, point));
}

export function freeArea(model: SpaceModel): number {
  return model.freeSpace.reduce((sum, [outer, ...holes]) => {
    return sum + ringArea(outer) - holes.reduce((h, hole) => h + ringArea(hole), 0);
  }, 0);
}

export function ringContains(ring: Ring, point: Point2): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      result = !result;
  }
  return result;
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (p: Point2, q: Point2, r: Point2) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  return (
    ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
    ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
  );
}

export function ringsOverlap(a: Ring, b: Ring): boolean {
  if (a.some((point) => ringContains(b, point))) return true;
  if (b.some((point) => ringContains(a, point))) return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (
        segmentsIntersect(
          a[i],
          a[(i + 1) % a.length],
          b[j],
          b[(j + 1) % b.length],
        )
      )
        return true;
  return false;
}

export function ringInside(inner: Ring, outer: Ring[]): boolean {
  const center = inner.reduce(
    (sum, point) => ({
      x: sum.x + point.x / inner.length,
      z: sum.z + point.z / inner.length,
    }),
    { x: 0, z: 0 },
  );
  return outer.some((ring) => {
    if (!ringContains(ring, center)) return false;
    for (const point of inner) {
      const nudged = {
        x: point.x + (center.x - point.x) * 1e-6,
        z: point.z + (center.z - point.z) * 1e-6,
      };
      if (!ringContains(ring, nudged)) return false;
    }
    for (let i = 0; i < inner.length; i++)
      for (let j = 0; j < ring.length; j++)
        if (
          segmentsIntersect(
            inner[i],
            inner[(i + 1) % inner.length],
            ring[j],
            ring[(j + 1) % ring.length],
          )
        )
          return false;
    return true;
  });
}

function hull(points: Point2[]): Ring {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (a: Point2, b: Point2, c: Point2) =>
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const half = (list: Point2[]) => {
    const result: Point2[] = [];
    for (const point of list) {
      while (
        result.length >= 2 &&
        cross(result[result.length - 2], result[result.length - 1], point) <= 0
      )
        result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

export function objectObstacle(object: RoomObject): Obstacle3D {
  const { width, height, depth } = object.dimensions;
  const transform = new Matrix4().compose(
    new Vector3(object.position.x, object.position.y, object.position.z),
    new Quaternion().setFromEuler(
      new Euler(object.rotation.x, object.rotation.y, object.rotation.z),
    ),
    new Vector3(1, 1, 1),
  );
  const corners: Vector3[] = [];
  for (const x of [-width / 2, width / 2])
    for (const y of [0, height])
      for (const z of [-depth / 2, depth / 2])
        corners.push(new Vector3(x, y, z).applyMatrix4(transform));
  return {
    id: object.id,
    name: object.name,
    category: object.category,
    footprint: hull(corners.map((point) => ({ x: point.x, z: point.z }))),
    bottom: Math.min(...corners.map((point) => point.y)),
    top: Math.max(...corners.map((point) => point.y)),
    locked: object.locked,
  };
}

function expandRing(ring: Ring, margin: number): Ring {
  const center = ring.reduce(
    (sum, point) => ({
      x: sum.x + point.x / ring.length,
      z: sum.z + point.z / ring.length,
    }),
    { x: 0, z: 0 },
  );
  return ring.map((point) => {
    const dx = point.x - center.x,
      dz = point.z - center.z;
    const length = Math.hypot(dx, dz) || 1;
    return {
      x: point.x + (dx / length) * margin,
      z: point.z + (dz / length) * margin,
    };
  });
}

function rectangleWalls(
  room: Extract<RoomSnapshot, { shape: "rectangle" }>,
): WallSegment[] {
  const { width, depth, height } = room.dimensions;
  const walls: Record<"north" | "east" | "south" | "west", WallSegment> = {
    north: { id: "north", start: { x: 0, z: 0 }, end: { x: width, z: 0 }, height, openings: [] },
    east: { id: "east", start: { x: width, z: 0 }, end: { x: width, z: depth }, height, openings: [] },
    south: { id: "south", start: { x: 0, z: depth }, end: { x: width, z: depth }, height, openings: [] },
    west: { id: "west", start: { x: 0, z: 0 }, end: { x: 0, z: depth }, height, openings: [] },
  };
  for (const opening of room.openings) {
    const wall = walls[opening.wall];
    const horizontal = opening.wall === "north" || opening.wall === "south";
    const start = horizontal
      ? { x: opening.offset, z: wall.start.z }
      : { x: wall.start.x, z: opening.offset };
    const end = horizontal
      ? { x: opening.offset + opening.width, z: wall.start.z }
      : { x: wall.start.x, z: opening.offset + opening.width };
    wall.openings.push({ kind: opening.kind, start, end });
  }
  return Object.values(walls);
}

function rectangleDoorClearances(
  room: Extract<RoomSnapshot, { shape: "rectangle" }>,
): ClearanceZone[] {
  return room.openings
    .filter((opening) => opening.kind === "door")
    .map((door) => {
      const { width, depth } = room.dimensions;
      const clearance = Math.max(DOOR_CLEARANCE, door.width);
      const ring: Ring =
        door.wall === "north"
          ? rectangleRing({ x: door.offset + door.width / 2, z: clearance / 2 }, door.width + clearance, clearance)
          : door.wall === "south"
            ? rectangleRing({ x: door.offset + door.width / 2, z: depth - clearance / 2 }, door.width + clearance, clearance)
            : door.wall === "west"
              ? rectangleRing({ x: clearance / 2, z: door.offset + door.width / 2 }, clearance, door.width + clearance)
              : rectangleRing({ x: width - clearance / 2, z: door.offset + door.width / 2 }, clearance, door.width + clearance);
      return {
        id: `door-${door.id}`,
        kind: "door" as const,
        footprint: ring,
        reason: `Keep ${clearance.toFixed(2)} m clear in front of door ${door.id}.`,
      };
    });
}

// Surface corners run around the perimeter: the first and last can share the
// same X/Z position. Find the full extent along the surface's local width axis.
function horizontalSpan(surface: CapturedSurface): { start: Point2; end: Point2 } {
  const points = worldCorners(surface).map(({ x, z }) => ({ x, z }));
  const along = (point: Point2) =>
    point.x * surface.transform[0] + point.z * surface.transform[2];
  let start = points[0];
  let end = points[0];
  for (const point of points) {
    if (along(point) < along(start)) start = point;
    if (along(point) > along(end)) end = point;
  }
  return { start, end };
}

export function buildSpaceModel(room: RoomSnapshot): SpaceModel {
  const warnings: string[] = [];
  const obstacles = room.objects.map(objectObstacle);
  let floor: Ring[];
  let walls: WallSegment[];
  let clearances: ClearanceZone[];
  let floorY = 0;
  if (room.shape === "rectangle") {
    floor = [rectangleRing({ x: room.dimensions.width / 2, z: room.dimensions.depth / 2 }, room.dimensions.width, room.dimensions.depth)];
    walls = rectangleWalls(room);
    clearances = rectangleDoorClearances(room);
  } else {
    const floorRings = room.floors.map((surface) =>
      worldCorners(surface).map((point) => ({ x: point.x, z: point.z })),
    );
    const heights = room.floors.flatMap((surface) =>
      worldCorners(surface).map((point) => point.y),
    );
    floorY = heights.length ? Math.min(...heights) : 0;
    floor = floorRings.length
      ? unionRings(floorRings)
      : [rectangleRing({ x: room.dimensions.width / 2, z: room.dimensions.depth / 2 }, room.dimensions.width, room.dimensions.depth)];
    if (!floorRings.length)
      warnings.push("The scan has no floor surface; using the room bounds as floor.");
    walls = room.walls.map((wall) => {
      const { start, end } = horizontalSpan(wall);
      const openings = room.openings
        .filter((opening) => opening.parentId === wall.id)
        .map((opening) => {
          return {
            kind: opening.kind === "door" ? ("door" as const) : opening.kind === "window" ? ("window" as const) : ("opening" as const),
            ...horizontalSpan(opening),
          };
        });
      return { id: wall.id, start, end, height: wall.dimensions.height, openings };
    });
    clearances = room.openings
      .filter((opening) => opening.kind === "door")
      .map((door) => {
        const { start, end } = horizontalSpan(door);
        const width = Math.hypot(end.x - start.x, end.z - start.z);
        const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
        const yaw = -Math.atan2(end.z - start.z, end.x - start.x);
        const clearance = Math.max(DOOR_CLEARANCE, width);
        return {
          id: `door-${door.id}`,
          kind: "door" as const,
          // Swing direction is unknown: reserve approach/swing depth on both
          // sides of the measured doorway, plus a shoulder past each jamb so
          // furniture cannot stand flush against the doorway.
          footprint: rectangleRing(
            center,
            Math.max(clearance, width + 0.6),
            clearance * 2,
            yaw,
          ),
          reason: `Keep ${clearance.toFixed(2)} m clear in front of door ${door.id}.`,
        };
      });
    if (room.measurementSource === "estimated")
      warnings.push("Room measurements are estimated; confirm before purchase.");
  }
  const blocked = [
    ...obstacles
      .filter((obstacle) => obstacle.category !== "rug")
      .map((obstacle) => expandRing(obstacle.footprint, FURNITURE_GAP)),
    ...clearances.map((zone) => zone.footprint),
  ];
  const freeSpace = subtractRings(floor, blocked);
  return {
    units: "meters",
    shape: room.shape,
    bounds: room.dimensions,
    floorY,
    floor,
    walls,
    obstacles,
    clearances,
    freeSpace,
    warnings,
  };
}
