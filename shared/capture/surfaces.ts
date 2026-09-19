import { Matrix4, Path, Shape } from "three";
import type { CapturedSurface } from "../contracts";
import { localCorners, worldCorners } from "./roomplan";

// Both rendering and tests use these shapes. Opening cuts are expressed in their
// parent wall's local XY plane, including door cuts that meet the bottom edge.
export function surfaceShape(
  surface: CapturedSurface,
  openings: CapturedSurface[] = [],
): Shape {
  const corners = localCorners(surface);
  const shape = new Shape();
  shape.moveTo(corners[0].x, corners[0].y);
  for (const p of corners.slice(1)) shape.lineTo(p.x, p.y);
  shape.closePath();
  const inverse = new Matrix4().fromArray(surface.transform).invert();
  for (const opening of openings.filter((o) => o.parentId === surface.id)) {
    const points = worldCorners(opening).map((p) => p.applyMatrix4(inverse));
    const hole = new Path();
    hole.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) hole.lineTo(p.x, p.y);
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}

export function floorArea(floors: CapturedSurface[]): number {
  return floors.reduce((area, floor) => {
    const points = localCorners(floor);
    return (
      area +
      Math.abs(
        points.reduce((sum, p, i) => {
          const next = points[(i + 1) % points.length];
          return sum + p.x * next.y - next.x * p.y;
        }, 0),
      ) /
        2
    );
  }, 0);
}
