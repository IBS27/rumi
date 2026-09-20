import { Vector3 } from "three";
import type { CapturedSurface } from "../contracts";
import { localCorners, worldCorners } from "../capture/roomplan";

function onFloor(x: number, z: number, floors: CapturedSurface[]) {
  return floors.some((floor) => {
    const points = worldCorners(floor);
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i],
        b = points[j];
      if (
        a.z > z !== b.z > z &&
        x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
      )
        inside = !inside;
    }
    return inside;
  });
}

// Only exterior walls qualify. Partitions have floor on both sides and must
// retain the bathroom/bedroom separation, even in the dollhouse overview.
export function exteriorNormal(
  wall: CapturedSurface,
  floors: CapturedSurface[],
) {
  const m = wall.transform;
  const normal = new Vector3(m[8], 0, m[10]).normalize();
  const offset = Math.max(0.16, wall.dimensions.depth / 2 + 0.08);
  const front = onFloor(
    m[12] + normal.x * offset,
    m[14] + normal.z * offset,
    floors,
  );
  const back = onFloor(
    m[12] - normal.x * offset,
    m[14] - normal.z * offset,
    floors,
  );
  return front === back ? null : normal.multiplyScalar(front ? -1 : 1);
}

export function lowerWall(
  wall: CapturedSurface,
  height = 0.75,
): CapturedSurface {
  const corners = localCorners(wall);
  // RoomPlan walls are upright. Preserve the wall's local plane and its origin.
  const top = height - wall.transform[13];
  const bottom = Math.min(...corners.map((p) => p.y));
  if (top <= bottom) return wall;
  const polygonCorners: CapturedSurface["polygonCorners"] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i],
      b = corners[(i + 1) % corners.length];
    if (a.y <= top) polygonCorners.push({ x: a.x, y: a.y, z: 0 });
    if (a.y <= top !== b.y <= top) {
      const t = (top - a.y) / (b.y - a.y);
      polygonCorners.push({ x: a.x + t * (b.x - a.x), y: top, z: 0 });
    }
  }
  return { ...wall, polygonCorners };
}
