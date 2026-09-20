import { Matrix4, Vector3 } from "three";
import type { CapturedRoom } from "../contracts";
import {
  floatBuffer,
  type CaptureFrame,
  type CapturePackage,
} from "../capture/package";
import { localCorners, worldCorners } from "../capture/roomplan";
import { visible, type Projector } from "../capture/texture";
import type { ReconstructionInput } from "./contracts";

export type PhotoPixels = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};
type Observation = NonNullable<
  ReconstructionInput["surfaceObservations"]
>[number];

function inside(x: number, y: number, polygon: readonly Vector3[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}

// Pixel sampling is depth-tested against the SAME measured surface. A towel,
// cabinet, doorway, or person in front of a wall must not become its paint color.
export function observeSurfaceColors(
  capture: CapturePackage,
  room: CapturedRoom,
  frame: CaptureFrame,
  pixels: PhotoPixels,
  photoIndex: number,
): Observation[] {
  const camera = new Matrix4().fromArray(frame.cameraTransform);
  const projector: Projector = {
    frame,
    inverse: camera.clone().invert(),
    position: new Vector3().setFromMatrixPosition(camera),
    depth: floatBuffer(capture.files[frame.depth]),
    confidence: capture.files[frame.confidence],
  };
  const origin = new Vector3(
    room.capture.origin.x,
    room.capture.origin.y,
    room.capture.origin.z,
  );
  const observations: Observation[] = [];
  for (const surface of [...room.walls, ...room.floors]) {
    const transform = new Matrix4().fromArray(surface.transform);
    const corners = localCorners(surface);
    const inverse = transform.clone().invert();
    const holes = room.openings
      .filter((o) => o.parentId === surface.id)
      .map((o) => worldCorners(o).map((p) => p.applyMatrix4(inverse)));
    const minX = Math.min(...corners.map((p) => p.x)),
      maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y)),
      maxY = Math.max(...corners.map((p) => p.y));
    const center = new Vector3().setFromMatrixPosition(transform).add(origin);
    const normal = new Vector3(0, 0, 1).transformDirection(transform);
    const direction = projector.position.clone().sub(center).normalize();
    const facing = normal.dot(direction);
    if (Math.abs(facing) < 0.25) continue;
    const channels: number[][] = [[], [], []];
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        const px = minX + ((x + 0.5) * (maxX - minX)) / 10;
        const py = minY + ((y + 0.5) * (maxY - minY)) / 10;
        if (!inside(px, py, corners)) continue;
        if (holes.some((polygon) => inside(px, py, polygon))) continue;
        const point = new Vector3(px, py, 0)
          .applyMatrix4(transform)
          .add(origin);
        const projected = visible(point, projector);
        if (!projected) continue;
        const index =
          (Math.floor(projected.v * pixels.height) * pixels.width +
            Math.floor(projected.u * pixels.width)) *
          4;
        const rgb = [
          pixels.data[index],
          pixels.data[index + 1],
          pixels.data[index + 2],
        ];
        // Discard clipped exposure; do not pretend black/white clipping measures paint.
        if (Math.max(...rgb) >= 250 || Math.max(...rgb) <= 8) continue;
        rgb.forEach((n, i) => channels[i].push(n));
      }
    if (channels[0].length < 8) continue;
    const color =
      "#" +
      channels
        .map((values) => {
          values.sort((a, b) => a - b);
          return values[Math.floor(values.length / 2)]
            .toString(16)
            .padStart(2, "0");
        })
        .join("");
    observations.push({
      surfaceId: surface.id,
      side: facing > 0 ? "front" : "back",
      photoIndex,
      color,
      samples: channels[0].length,
    });
  }
  return observations;
}

export function selectSurfaceObservations(
  values: Observation[],
): Observation[] {
  const groups = new Map<string, Observation[]>();
  for (const value of values) {
    const key = `${value.surfaceId}:${value.side}`;
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    group.sort((a, b) => b.samples - a.samples).slice(0, 3),
  );
}
