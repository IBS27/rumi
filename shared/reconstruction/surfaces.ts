import polygonClipping, { type Polygon, type Pair } from "polygon-clipping";
import { Path, Shape } from "three";
import type { CapturedSurface } from "../contracts";
import { surfaceShape } from "../capture/surfaces";

// Clip every appearance region to the measured wall/floor, including door holes.
// In particular, a tile region cannot fill a doorway or spill outside the room.
export function finishRegionShapes(
  surface: CapturedSurface,
  openings: CapturedSurface[],
  polygon: ReadonlyArray<{ x: number; y: number }>,
): Shape[] {
  const shapes = surfaceShape(surface, openings);
  const ring = (path: Path): Pair[] => path.getPoints().map((p) => [p.x, p.y]);
  const boundary: Polygon[] = shapes.map((shape) => [
    ring(shape),
    ...shape.holes.map(ring),
  ]);
  if (!boundary.length) return [];
  const region: Polygon = [polygon.map((p) => [p.x, p.y])];
  return polygonClipping
    .intersection(boundary, region)
    .map(([outer, ...holes]) => {
      const result = new Shape();
      result.moveTo(...outer[0]);
      for (const p of outer.slice(1)) result.lineTo(...p);
      result.closePath();
      for (const points of holes) {
        const path = new Path();
        path.moveTo(...points[0]);
        for (const p of points.slice(1)) path.lineTo(...p);
        path.closePath();
        result.holes.push(path);
      }
      return result;
    });
}
