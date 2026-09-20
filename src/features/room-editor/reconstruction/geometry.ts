import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { applyMeterUVs } from "./materials";

// Construct bevels in meters, then restore the normalized coordinates used by
// the captured assembly. A thin pillow should not inherit a bed-sized bevel.
export function roundedPartGeometry(
  size: readonly [number, number, number],
  meters: readonly [number, number, number],
  fabric: boolean,
) {
  const physical = size.map((n, i) => n * meters[i]);
  const radius = Math.min(...physical) * (fabric ? 0.32 : 0.08);
  const geometry = new RoundedBoxGeometry(
    physical[0],
    physical[1],
    physical[2],
    fabric ? 3 : 1,
    Math.min(radius, fabric ? 0.065 : 0.004),
  );
  if (fabric) {
    const positions = geometry.getAttribute("position");
    // Low-amplitude cloth undulation stays INSIDE the measured envelope.
    // It changes highlights without adding extra meshes or invented decor.
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i),
        y = positions.getY(i),
        z = positions.getZ(i);
      const envelope =
        Math.max(0, 1 - ((2 * x) / physical[0]) ** 2) *
        Math.max(0, 1 - ((2 * z) / physical[2]) ** 2);
      const ripple =
        (0.5 + 0.5 * Math.sin(x * 43 + Math.sin(z * 17))) * envelope;
      positions.setY(i, y * (1 - 0.045 * ripple));
    }
    geometry.computeVertexNormals();
  }
  geometry.scale(1 / meters[0], 1 / meters[1], 1 / meters[2]);
  applyMeterUVs(geometry, meters, "box");
  return geometry;
}
