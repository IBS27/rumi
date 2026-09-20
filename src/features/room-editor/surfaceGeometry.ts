import { ExtrudeGeometry } from "three";
import type { CapturedSurface } from "../../../shared/contracts";
import { surfaceShape } from "../../../shared/capture/surfaces";

// RoomPlan often reports zero wall depth and snaps furniture onto that plane.
// A solid shell keeps those furniture faces behind the exterior wall instead
// of competing with a coplanar sheet. This affects display geometry only.
export function surfaceGeometry(
  surface: CapturedSurface,
  openings: CapturedSurface[],
) {
  const wall = surface.kind === "wall";
  const thickness = wall
    ? Math.max(0.08, Math.min(0.2, surface.dimensions.depth))
    : 0.08;
  const geometry = new ExtrudeGeometry(surfaceShape(surface, openings), {
    depth: thickness,
    bevelEnabled: false,
    steps: 1,
  });
  // Floor local +Z can point up or down. Keep its measured top unchanged.
  return geometry.translate(
    0,
    0,
    wall ? -thickness / 2 : surface.transform[9] > 0 ? -thickness : 0,
  );
}
