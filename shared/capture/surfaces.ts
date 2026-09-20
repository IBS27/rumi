import { Matrix4, Path, Shape } from "three";
import polygonClipping, { type Polygon } from "polygon-clipping";
import type { CapturedSurface } from "../contracts";
import { localCorners, worldCorners } from "./roomplan";

// Both rendering and tests use these shapes. Opening cuts are expressed in their
// parent wall's local XY plane, including door cuts that meet the bottom edge.
export function surfaceShape(
  surface: CapturedSurface,
  openings: CapturedSurface[] = [],
): Shape[] {
  const corners = localCorners(surface);
  const boundary: Polygon = [corners.map((p) => [p.x, p.y])];
  const inverse = new Matrix4().fromArray(surface.transform).invert();
  const cuts: Polygon[] = [];
  for (const opening of openings.filter((o) => o.parentId === surface.id)) {
    const points = worldCorners(opening).map((p) => p.applyMatrix4(inverse));
    // A floor-reaching door is a notch, not an enclosed hole. Snap tiny scan
    // roundoff to the wall edge; otherwise Earcut can silently fill the doorway.
    const bottom = Math.min(...corners.map((p) => p.y));
    cuts.push([
      points.map((p) => [
        p.x,
        opening.kind !== "window" && Math.abs(p.y - bottom) < 0.015
          ? bottom - 0.001
          : p.y,
      ]),
    ]);
  }
  const polygons = cuts.length
    ? polygonClipping.difference(boundary, ...cuts)
    : [boundary];
  return polygons.map(([outer, ...holes]) => {
    const shape = new Shape();
    shape.moveTo(...outer[0]);
    for (const p of outer.slice(1)) shape.lineTo(...p);
    shape.closePath();
    for (const ring of holes) {
      const hole = new Path();
      hole.moveTo(...ring[0]);
      for (const p of ring.slice(1)) hole.lineTo(...p);
      hole.closePath();
      shape.holes.push(hole);
    }
    return shape;
  });
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
