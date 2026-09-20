import { Matrix4, Vector3 } from "three";
import {
  floatBuffer,
  uintBuffer,
  type CaptureFrame,
  type CapturePackage,
} from "./package";
import { importRoomPlan } from "./roomplan";

export type ScanBatch = {
  image: string | null;
  structural: boolean;
  positions: Float32Array;
  uvs: Float32Array;
};
export type TexturedScan = {
  batches: ScanBatch[];
  images: { name: string; bytes: Uint8Array; width: number; height: number }[];
  faceCount: number;
  texturedFaceCount: number;
  warnings: string[];
};
type Projector = {
  frame: CaptureFrame;
  inverse: Matrix4;
  depth: Float32Array;
  confidence: Uint8Array;
  position: Vector3;
};

/** ARKit cameras look down -Z; JPEG pixels use +X right, +Y down. */
export function projectPoint(
  point: Vector3,
  frame: CaptureFrame,
  inverse: Matrix4,
) {
  const p = point.clone().applyMatrix4(inverse);
  const depth = -p.z;
  if (depth <= 0.05) return null;
  const u = ((frame.fx * p.x) / depth + frame.cx) / frame.width;
  const v = ((-frame.fy * p.y) / depth + frame.cy) / frame.height;
  return u > 0.01 && u < 0.99 && v > 0.01 && v < 0.99 ? { u, v, depth } : null;
}
function visible(point: Vector3, projector: Projector) {
  const p = projectPoint(point, projector.frame, projector.inverse);
  if (!p) return null;
  const { depthWidth: w, depthHeight: h } = projector.frame;
  // Require nearby depth agreement too, so foreground edges do not bleed onto furniture.
  const x = Math.min(w - 1, Math.floor(p.u * w));
  const y = Math.min(h - 1, Math.floor(p.v * h));
  const index = y * w + x;
  const measured = projector.depth[index];
  if (
    projector.confidence[index] < 1 ||
    !Number.isFinite(measured) ||
    measured <= 0 ||
    Math.abs(measured - p.depth) > Math.max(0.06, p.depth * 0.025)
  )
    return null;
  return p;
}

/** Runs in a worker. A single unobstructed photo textures each triangle. Unknown areas stay neutral. */
export function textureCapture(capture: CapturePackage): TexturedScan {
  const { manifest, files } = capture;
  const original = importRoomPlan(capture.saved.original);
  const origin = new Vector3(
    original.capture.origin.x,
    original.capture.origin.y,
    original.capture.origin.z,
  );
  const projectors: Projector[] = manifest.frames.map((frame) => ({
    frame,
    inverse: new Matrix4().fromArray(frame.cameraTransform).invert(),
    position: new Vector3().setFromMatrixPosition(
      new Matrix4().fromArray(frame.cameraTransform),
    ),
    depth: floatBuffer(files[frame.depth]),
    confidence: files[frame.confidence],
  }));
  const groups = new Map<
    string,
    {
      image: string | null;
      structural: boolean;
      positions: number[];
      uvs: number[];
    }
  >();
  let faceCount = 0,
    texturedFaceCount = 0;
  for (const mesh of manifest.meshes) {
    const positions = floatBuffer(files[mesh.positions]);
    const indices = uintBuffer(files[mesh.indices]);
    const matrix = new Matrix4().fromArray(mesh.transform);
    const a = new Vector3(),
      b = new Vector3(),
      c = new Vector3();
    for (let i = 0; i < indices.length; i += 3) {
      a.fromArray(positions, indices[i] * 3).applyMatrix4(matrix);
      b.fromArray(positions, indices[i + 1] * 3).applyMatrix4(matrix);
      c.fromArray(positions, indices[i + 2] * 3).applyMatrix4(matrix);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      if (normal.lengthSq() < 1e-12) continue;
      normal.normalize();
      const center = a
        .clone()
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
      let best: { image: string; uv: number[] } | null = null;
      let bestScore = 0;
      for (const projector of projectors) {
        const direction = projector.position.clone().sub(center);
        const distance = direction.length();
        const facing = normal.dot(direction.normalize());
        if (facing < 0.2) continue;
        const score = (facing * projector.frame.fx) / Math.max(distance, 0.1);
        if (score <= bestScore || !visible(center, projector)) continue;
        const pa = visible(a, projector),
          pb = visible(b, projector),
          pc = visible(c, projector);
        if (!pa || !pb || !pc) continue;
        bestScore = score;
        // Texture flipY=false, so UVs deliberately retain the JPEG's top-left origin.
        best = {
          image: projector.frame.image,
          uv: [pa.u, pa.v, pb.u, pb.v, pc.u, pc.v],
        };
      }
      const classification = files[mesh.classifications][i / 3];
      // ARMeshClassification: wall=1, floor=2, ceiling=3, table=4, seat=5, window=6, door=7.
      const structural = [1, 3, 6, 7].includes(classification);
      const key = `${best?.image ?? "untextured"}-${structural}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          image: best?.image ?? null,
          structural,
          positions: [],
          uvs: [],
        };
        groups.set(key, group);
      }
      for (const p of [a, b, c]) {
        p.sub(origin);
        group.positions.push(p.x, p.y, p.z);
      }
      group.uvs.push(...(best?.uv ?? [0, 0, 0, 0, 0, 0]));
      faceCount++;
      if (best) texturedFaceCount++;
    }
  }
  if (!faceCount)
    throw new Error("The scan contains no usable surface triangles.");
  const used = new Set([...groups.values()].map((group) => group.image));
  return {
    batches: [...groups.values()].map((group) => ({
      ...group,
      positions: new Float32Array(group.positions),
      uvs: new Float32Array(group.uvs),
    })),
    images: manifest.frames
      .filter((frame) => used.has(frame.image))
      .map((frame) => ({
        name: frame.image,
        bytes: files[frame.image],
        width: frame.width,
        height: frame.height,
      })),
    faceCount,
    texturedFaceCount,
    warnings: manifest.warnings,
  };
}
