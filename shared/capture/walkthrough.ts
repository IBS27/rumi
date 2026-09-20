import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import polygonClipping, { type Polygon } from "polygon-clipping";
import type { CapturedRoom } from "../contracts";
import { worldCorners } from "./roomplan";
import { surfaceShape } from "./surfaces";

type Point = { x: number; z: number };
export type WalkPosition = Point & { y: number };
type Floor = { points: Point[]; y: number; boundary: Point[][] };
type Obstacle = {
  points: Point[];
  bottom: number;
  top: number;
  floorY?: number;
};
export type Walkthrough = {
  floors: Floor[];
  obstacles: Obstacle[];
  start: WalkPosition | null;
};

export const WALK_RADIUS = 0.2;
export const EYE_HEIGHT = 1.6;
const MAX_STEP = 0.18;

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = dx * dx + dz * dz;
  const t = length
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}

function edgeDistance(p: Point, points: Point[]): number {
  return Math.min(
    ...points.map((a, i) =>
      segmentDistance(p, a, points[(i + 1) % points.length]),
    ),
  );
}

function inside(p: Point, points: Point[]): boolean {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      result = !result;
  }
  return result;
}

// Project all eight furniture corners, including pitch and roll, into a convex
// footprint. An axis-aligned box would block empty space around rotated items.
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const half = (list: Point[]) => {
    const result: Point[] = [];
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

function clearance(model: Walkthrough, p: Point, floor: Floor): number {
  // Include a patch's edge so a center exactly on a shared seam has a floor.
  if (
    !floor.boundary.length ||
    (!inside(p, floor.points) && edgeDistance(p, floor.points) > 1e-8)
  )
    return -1;
  let distance = Math.min(
    ...floor.boundary.map((ring) => edgeDistance(p, ring)),
  );
  for (const obstacle of model.obstacles) {
    if (
      (obstacle.floorY !== undefined && obstacle.floorY !== floor.y) ||
      obstacle.top <= floor.y + 0.08 ||
      obstacle.bottom >= floor.y + EYE_HEIGHT + 0.15
    )
      continue;
    if (inside(p, obstacle.points)) return -1;
    distance = Math.min(distance, edgeDistance(p, obstacle.points));
  }
  return distance;
}

export function createWalkthrough(room: CapturedRoom): Walkthrough {
  const floors = room.floors.flatMap((floor): Floor[] => {
    const points = worldCorners(floor);
    const low = Math.min(...points.map((p) => p.y));
    const high = Math.max(...points.map((p) => p.y));
    // Flat floors only. Do not invent a boundary from the room's bounding box,
    // or place an eye-level camera under a low ceiling.
    return high - low <= 0.1 &&
      room.dimensions.height - high >= EYE_HEIGHT + 0.15
      ? [{ points, y: high, boundary: [] }]
      : [];
  });
  // Measure standing clearance against the union, not internal patch seams.
  // Keep hole rings and separate islands; only floors within one safe step of
  // this elevation may support the footprint. Do not merge heights transitively.
  const boundaries = new Map<number, Point[][]>();
  for (const floor of floors) {
    let boundary = boundaries.get(floor.y);
    if (!boundary) {
      const polygons: Polygon[] = floors
        .filter((other) => Math.abs(other.y - floor.y) <= MAX_STEP)
        .map((other) => [other.points.map((p) => [p.x, p.z])]);
      try {
        boundary = polygonClipping
          .union(polygons[0], ...polygons.slice(1))
          .flatMap((polygon) =>
            polygon.map((ring) => ring.map(([x, z]) => ({ x, z }))),
          );
      } catch {
        // Unusable captured polygons must not crash the editor or permit walking.
        boundary = [];
      }
      boundaries.set(floor.y, boundary);
    }
    floor.boundary = boundary;
  }
  const obstacles: Obstacle[] = room.walls.flatMap((wall): Obstacle[] => {
    const corners = worldCorners(wall);
    const solid: Obstacle = {
      points: hull(corners),
      bottom: Math.min(...corners.map((p) => p.y)),
      top: Math.max(...corners.map((p) => p.y)),
    };
    const doorways = room.openings.filter(
      (opening) => opening.parentId === wall.id && opening.kind !== "window",
    );
    if (!doorways.length) return [solid];
    const matrix = new Matrix4().fromArray(wall.transform);
    return [...new Set(floors.map((floor) => floor.y))].flatMap((floorY) => {
      const passable = doorways.filter((opening) => {
        const points = worldCorners(opening);
        return (
          Math.min(...points.map((p) => p.y)) <= floorY + 0.08 &&
          Math.max(...points.map((p) => p.y)) >= floorY + EYE_HEIGHT + 0.15
        );
      });
      if (!passable.length) return [{ ...solid, floorY }];
      // Project only the jambs into the walking footprint. Projecting the whole
      // wall (or its lintel) into XZ closes every internal doorway. Extend cuts
      // vertically for this collision-only projection once headroom is checked.
      const cuts = passable.map((opening) => ({
        ...opening,
        polygonCorners: [],
        dimensions: {
          ...opening.dimensions,
          height: Math.max(wall.dimensions.height, room.dimensions.height) * 4,
        },
      }));
      return surfaceShape(wall, cuts).map((shape) => ({
        ...solid,
        floorY,
        points: hull(
          shape
            .getPoints()
            .map((p) => new Vector3(p.x, p.y, 0).applyMatrix4(matrix)),
        ),
      }));
    });
  });
  for (const object of room.objects) {
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
    obstacles.push({
      points: hull(corners),
      bottom: Math.min(...corners.map((p) => p.y)),
      top: Math.max(...corners.map((p) => p.y)),
    });
  }
  const model: Walkthrough = { floors, obstacles, start: null };
  let best = WALK_RADIUS;
  // Bounded search for an unobstructed spawn, even in a concave or furnished
  // room. Maximize clearance instead of assuming the room center is empty.
  for (let x = 0; x <= 40; x++) {
    for (let z = 0; z <= 40; z++) {
      const p = {
        x: (room.dimensions.width * x) / 40,
        z: (room.dimensions.depth * z) / 40,
      };
      for (const floor of floors) {
        const distance = clearance(model, p, floor);
        if (distance > best) {
          best = distance;
          model.start = { ...p, y: floor.y };
        }
      }
    }
  }
  return model;
}

export function walkPosition(
  model: Walkthrough,
  p: Point,
  currentY: number,
): WalkPosition | null {
  const floor = model.floors.find(
    (floor) =>
      Math.abs(floor.y - currentY) <= MAX_STEP &&
      clearance(model, p, floor) >= WALK_RADIUS,
  );
  return floor ? { ...p, y: floor.y } : null;
}

export function moveWalk(
  model: Walkthrough,
  start: WalkPosition,
  dx: number,
  dz: number,
): WalkPosition {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (WALK_RADIUS / 2)));
  let position = start;
  for (let i = 0; i < steps; i++) {
    const next = walkPosition(
      model,
      { x: position.x + dx / steps, z: position.z + dz / steps },
      position.y,
    );
    // Slide along obstacles when a diagonal step is blocked.
    position =
      next ??
      walkPosition(
        model,
        { x: position.x + dx / steps, z: position.z },
        position.y,
      ) ??
      walkPosition(
        model,
        { x: position.x, z: position.z + dz / steps },
        position.y,
      ) ??
      position;
  }
  return position;
}
