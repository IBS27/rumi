import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { CapturedRoom } from "../contracts";
import { worldCorners } from "./roomplan";

type Point = { x: number; z: number };
export type WalkPosition = Point & { y: number };
type Floor = { points: Point[]; y: number };
type Obstacle = { points: Point[]; bottom: number; top: number };
export type Walkthrough = {
  floors: Floor[];
  obstacles: Obstacle[];
  start: WalkPosition | null;
};

export const WALK_RADIUS = 0.2;
export const EYE_HEIGHT = 1.6;

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
  if (!inside(p, floor.points)) return -1;
  let distance = edgeDistance(p, floor.points);
  for (const obstacle of model.obstacles) {
    if (
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
      ? [{ points, y: high }]
      : [];
  });
  const obstacles: Obstacle[] = room.walls.map((wall) => {
    const corners = worldCorners(wall);
    // Solid wall footprints also keep the user inside at exterior doorways.
    return {
      points: hull(corners),
      bottom: Math.min(...corners.map((p) => p.y)),
      top: Math.max(...corners.map((p) => p.y)),
    };
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
      Math.abs(floor.y - currentY) <= 0.18 &&
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
