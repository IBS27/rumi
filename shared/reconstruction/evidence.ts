import { Matrix4, Vector3 } from "three";
import type { CaptureFrame, CapturePackage } from "../capture/package";
import { importRoomPlan } from "../capture/roomplan";
import {
  observeSurfaceColors,
  selectSurfaceObservations,
  type PhotoPixels,
} from "./colors";
import {
  MAX_EVIDENCE_BYTES,
  reconstructionInputSchema,
  type ReconstructionInput,
} from "./contracts";

// Farthest-point sampling in position AND direction keeps different sides of the
// room, rather than picking the first sixteen nearly identical camera frames.
export function selectCaptureViews(
  frames: CaptureFrame[],
  maximum = 16,
): CaptureFrame[] {
  if (frames.length <= maximum) return frames;
  const selected = [frames[0]];
  const remaining = new Set(frames.slice(1));
  const distance = (a: CaptureFrame, b: CaptureFrame) => {
    const p = a.cameraTransform,
      q = b.cameraTransform;
    return (
      Math.min(
        9,
        (p[12] - q[12]) ** 2 + (p[13] - q[13]) ** 2 + (p[14] - q[14]) ** 2,
      ) +
      4 *
        (1 -
          Math.min(1, Math.max(-1, p[8] * q[8] + p[9] * q[9] + p[10] * q[10])))
    );
  };
  while (selected.length < maximum && remaining.size) {
    let best: CaptureFrame | undefined,
      score = -1;
    for (const frame of remaining) {
      const nearest = Math.min(
        ...selected.map((view) => distance(frame, view)),
      );
      if (nearest > score) {
        best = frame;
        score = nearest;
      }
    }
    if (!best) break;
    selected.push(best);
    remaining.delete(best);
  }
  return selected;
}

export async function buildReconstructionEvidence(
  capture: CapturePackage,
  resize: (
    bytes: Uint8Array,
    frame: CaptureFrame,
  ) => Promise<{
    jpeg: string;
    width: number;
    height: number;
    pixels?: PhotoPixels;
  }>,
): Promise<ReconstructionInput> {
  // Edits must never shift scan geometry or camera poses a second time.
  const room = importRoomPlan(capture.saved.original);
  room.capture.synthetic = capture.manifest.synthetic;
  const origin = new Vector3(
    room.capture.origin.x,
    room.capture.origin.y,
    room.capture.origin.z,
  );
  const faceCount = capture.manifest.meshes.reduce(
    (sum, mesh) => sum + mesh.faceCount,
    0,
  );
  const stride = Math.max(1, Math.ceil(faceCount / 1200));
  const samples: ReconstructionInput["mesh"]["samples"] = [];
  let faceOffset = 0;
  for (const mesh of capture.manifest.meshes) {
    const positions = capture.files[mesh.positions],
      indices = capture.files[mesh.indices];
    const pv = new DataView(
      positions.buffer,
      positions.byteOffset,
      positions.byteLength,
    );
    const iv = new DataView(
      indices.buffer,
      indices.byteOffset,
      indices.byteLength,
    );
    const matrix = new Matrix4().fromArray(mesh.transform);
    for (
      let face = (stride - (faceOffset % stride)) % stride;
      face < mesh.faceCount;
      face += stride
    ) {
      const vertices: number[] = [];
      for (let corner = 0; corner < 3; corner++) {
        const index = iv.getUint32((face * 3 + corner) * 4, true) * 12;
        const point = new Vector3(
          pv.getFloat32(index, true),
          pv.getFloat32(index + 4, true),
          pv.getFloat32(index + 8, true),
        )
          .applyMatrix4(matrix)
          .sub(origin);
        vertices.push(
          ...point.toArray().map((n) => Math.round(n * 1000) / 1000),
        );
      }
      samples.push({
        vertices,
        classification: capture.files[mesh.classifications][face],
      });
    }
    faceOffset += mesh.faceCount;
  }
  const photos: ReconstructionInput["photos"] = [];
  const observations: NonNullable<ReconstructionInput["surfaceObservations"]> =
    [];
  for (const frame of selectCaptureViews(capture.manifest.frames)) {
    const { pixels, ...image } = await resize(
      capture.files[frame.image],
      frame,
    );
    if (pixels)
      observations.push(
        ...observeSurfaceColors(capture, room, frame, pixels, photos.length),
      );
    const cameraTransform = [...frame.cameraTransform];
    cameraTransform[12] -= origin.x;
    cameraTransform[13] -= origin.y;
    cameraTransform[14] -= origin.z;
    photos.push({
      ...image,
      cameraTransform,
      fx: (frame.fx * image.width) / frame.width,
      fy: (frame.fy * image.height) / frame.height,
      cx: (frame.cx * image.width) / frame.width,
      cy: (frame.cy * image.height) / frame.height,
    });
  }
  const input = reconstructionInputSchema.parse({
    version: 1,
    room,
    mesh: { faceCount, samples },
    photos,
    ...(observations.length
      ? { surfaceObservations: selectSurfaceObservations(observations) }
      : {}),
  });
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength >
    MAX_EVIDENCE_BYTES
  )
    throw new Error("This scan's reconstruction evidence is too large.");
  return input;
}
