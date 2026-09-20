import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { syntheticRoomPlan } from "../../shared/fixtures/roomplan";
import type { CaptureManifest } from "../../shared/capture/package";

export const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function syntheticCaptureFiles() {
  const camera = [...identityMatrix];
  camera[12] = 2;
  camera[13] = 1;
  camera[14] = 4;
  const manifest: CaptureManifest = {
    format: "rumi.capture",
    version: 1,
    coordinates: "arkit-world-meters-y-up",
    synthetic: true,
    room: "roomplan.json",
    warnings: ["Synthetic projection fixture. Not a measured room."],
    meshes: [
      {
        positions: "mesh.bin",
        indices: "indices.bin",
        classifications: "classes.bin",
        transform: [...identityMatrix],
        vertexCount: 3,
        faceCount: 1,
      },
    ],
    frames: [
      {
        image: "photo.jpg",
        depth: "depth.bin",
        confidence: "confidence.bin",
        width: 64,
        height: 64,
        depthWidth: 8,
        depthHeight: 8,
        fx: 32,
        fy: 32,
        cx: 32,
        cy: 32,
        cameraTransform: camera,
        timestamp: 10,
      },
    ],
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "roomplan.json": strToU8(JSON.stringify(syntheticRoomPlan)),
    "mesh.bin": new Uint8Array(
      new Float32Array([1, 0, 2, 3, 0, 2, 2, 2, 2]).buffer,
    ),
    "indices.bin": new Uint8Array(new Uint32Array([0, 1, 2]).buffer),
    "classes.bin": new Uint8Array([5]),
    "photo.jpg": new Uint8Array(
      readFileSync(new URL("./synthetic-scan.jpg", import.meta.url)),
    ),
    "depth.bin": new Uint8Array(new Float32Array(64).fill(2).buffer),
    "confidence.bin": new Uint8Array(64).fill(2),
  };
  return { files, manifest };
}
export function syntheticCaptureZip() {
  return zipSync(syntheticCaptureFiles().files, { level: 0 });
}
