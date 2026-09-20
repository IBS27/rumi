import { expect, it } from "bun:test";
import {
  BoxGeometry,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Vector3,
} from "three";
import type { CapturedSurface } from "../shared/contracts";
import { surfaceGeometry } from "../src/features/room-editor/surfaceGeometry";

function wall(): CapturedSurface {
  return {
    id: "wall",
    kind: "wall",
    parentId: null,
    confidence: "high",
    dimensions: { width: 2.5447345, height: 4.0200005, depth: 0 },
    transform: new Matrix4().identity().toArray(),
    polygonCorners: [],
  };
}

it("occludes a cabinet snapped within two micrometres of an exterior wall", () => {
  const surface = wall();
  const original = structuredClone(surface);
  const material = new MeshBasicMaterial({ side: DoubleSide });
  const shell = new Mesh(surfaceGeometry(surface, []), material);
  const cabinet = new Mesh(
    new BoxGeometry(2.3901823, 0.7290952, 0.4380688),
    material,
  );
  // Reproduces the supplied scan's wall-local back face and bottom elevation.
  cabinet.position.set(0.0772755, -1.6454526, 0.4380688 / 2 + 0.0000015);
  cabinet.updateMatrixWorld();
  shell.updateMatrixWorld();
  try {
    for (const x of [-0.8, 0, 0.8]) {
      const ray = new Raycaster(new Vector3(x, -1.6, -3), new Vector3(0, 0, 1));
      const hits = ray.intersectObjects([shell, cabinet]);
      expect(hits[0].object).toBe(shell);
      const cabinetHit = hits.find((hit) => hit.object === cabinet)!;
      expect(cabinetHit.distance - hits[0].distance).toBeGreaterThan(0.039);
      // The cabinet remains visible from inside the room.
      ray.set(new Vector3(x, -1.6, 3), new Vector3(0, 0, -1));
      expect(ray.intersectObjects([shell, cabinet])[0].object).toBe(cabinet);
    }
    expect(surface).toEqual(original);
  } finally {
    shell.geometry.dispose();
    cabinet.geometry.dispose();
    material.dispose();
  }
});

it("keeps window holes open through both faces of a solid wall", () => {
  const surface = wall();
  const opening: CapturedSurface = {
    ...surface,
    id: "window",
    kind: "window",
    parentId: surface.id,
    dimensions: { width: 1, height: 1, depth: 0 },
  };
  const mesh = new Mesh(
    surfaceGeometry(surface, [opening]),
    new MeshBasicMaterial({ side: DoubleSide }),
  );
  mesh.updateMatrixWorld();
  try {
    for (const side of [-1, 1]) {
      const ray = new Raycaster(
        new Vector3(0, 0, side * 3),
        new Vector3(0, 0, -side),
      );
      expect(ray.intersectObject(mesh)).toHaveLength(0);
      ray.set(new Vector3(0.8, 0, side * 3), new Vector3(0, 0, -side));
      expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
    }
  } finally {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

it("extrudes floors downward for either captured normal without moving the top", () => {
  for (const angle of [-Math.PI / 2, Math.PI / 2]) {
    const floor: CapturedSurface = {
      ...wall(),
      kind: "floor",
      transform: new Matrix4().makeRotationX(angle).toArray(),
    };
    const geometry = surfaceGeometry(floor, []);
    geometry.applyMatrix4(new Matrix4().fromArray(floor.transform));
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0, 6);
    expect(geometry.boundingBox!.min.y).toBeCloseTo(-0.08, 6);
    geometry.dispose();
  }
});
