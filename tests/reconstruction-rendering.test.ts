import { describe, it, expect } from "bun:test";
import { ShapeGeometry, Vector3 } from "three";
import { surfaceShape } from "../shared/capture/surfaces";
import { importRoomPlan } from "../shared/capture/roomplan";
import { readPackage, floatBuffer } from "../shared/capture/package";
import {
  syntheticCaptureZip,
  identityMatrix,
} from "./fixtures/capture-package";
import { observeSurfaceColors } from "../shared/reconstruction/colors";
import { mapConcurrent } from "../shared/reconstruction/concurrency";
import { buildReconstructionEvidence } from "../shared/reconstruction/evidence";
import { reconstructionInputSchema } from "../shared/reconstruction/contracts";
import { roundedPartGeometry } from "../src/features/room-editor/reconstruction/geometry";
import {
  exteriorNormal,
  lowerWall,
  shouldLowerWall,
} from "../shared/reconstruction/architecture";

describe("reconstruction fidelity", () => {
  it("holds the cutaway state while the camera jitters near the boundary", () => {
    let lowered = false;
    for (const facing of [0.18, 0.22, 0.19, 0.24]) {
      lowered = shouldLowerWall(facing, lowered);
      expect(lowered).toBe(false);
    }
    lowered = shouldLowerWall(0.3, lowered);
    expect(lowered).toBe(true);
    for (const facing of [0.22, 0.18, 0.24, 0.16]) {
      lowered = shouldLowerWall(facing, lowered);
      expect(lowered).toBe(true);
    }
    expect(shouldLowerWall(0.1, lowered)).toBe(false);
  });
  it("rejects color observations for absent photos and unmeasured surfaces", async () => {
    const input = await buildReconstructionEvidence(
      readPackage(syntheticCaptureZip()),
      async () => ({ jpeg: "/9j/2Q==", width: 32, height: 32 }),
    );
    if (input.room.shape !== "polygon")
      throw new Error("Missing captured room");
    const observation = {
      surfaceId: input.room.walls[0].id,
      photoIndex: 0,
      side: "front" as const,
      color: "#465a78",
      samples: 30,
    };
    expect(
      reconstructionInputSchema.safeParse({
        ...input,
        surfaceObservations: [observation],
      }).success,
    ).toBe(true);
    for (const value of [
      { ...observation, photoIndex: 15 },
      { ...observation, surfaceId: "missing-wall" },
    ]) {
      expect(
        reconstructionInputSchema.safeParse({
          ...input,
          surfaceObservations: [value],
        }).success,
      ).toBe(false);
    }
    expect(
      reconstructionInputSchema.safeParse({
        ...input,
        surfaceObservations: [observation, observation],
      }).success,
    ).toBe(false);
  });
  it("cuts away exterior walls only and keeps shortened geometry on its measured plane", () => {
    const room = importRoomPlan(
      readPackage(syntheticCaptureZip()).saved.original,
    );
    const exterior = room.walls[0];
    const outward = exteriorNormal(exterior, room.floors)!;
    expect(outward.z).toBeLessThan(-0.9);
    const partition = { ...exterior, transform: [...exterior.transform] };
    partition.transform[14] = 1.5;
    expect(exteriorNormal(partition, room.floors)).toBeNull();
    const low = lowerWall(exterior);
    expect(low.transform).toEqual(exterior.transform);
    expect(
      Math.max(...low.polygonCorners.map((p) => p.y)) + low.transform[13],
    ).toBeCloseTo(0.75);
  });
  it("keeps floor-reaching doorways open despite submillimeter scan roundoff", () => {
    const capture = readPackage(syntheticCaptureZip());
    const room = importRoomPlan(capture.saved.original);
    const wall = {
      ...room.walls[0],
      id: "wall",
      transform: [...identityMatrix],
      dimensions: { width: 2, height: 2.28, depth: 0 },
    };
    const door = {
      ...wall,
      id: "door",
      kind: "door" as const,
      parentId: "wall",
      dimensions: { width: 0.83, height: 2.068776, depth: 0 },
      transform: [...identityMatrix],
    };
    door.transform[13] = -0.105612062;
    const geometry = new ShapeGeometry(surfaceShape(wall, [door]));
    const p = geometry.getAttribute("position"),
      indices = geometry.index!;
    let area = 0;
    for (let i = 0; i < indices.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(p, indices.getX(i));
      const b = new Vector3().fromBufferAttribute(p, indices.getX(i + 1));
      const c = new Vector3().fromBufferAttribute(p, indices.getX(i + 2));
      const center = a.clone().add(b).add(c).divideScalar(3);
      expect(Math.abs(center.x) < 0.415 && center.y < 0.9287).toBe(false);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    expect(area).toBeCloseTo(2 * 2.28 - 0.83 * 2.068776, 5);
    geometry.dispose();
  });

  it("samples wall pixels while rejecting a foreground occluder and door leaves", () => {
    const capture = readPackage(syntheticCaptureZip());
    const room = importRoomPlan(capture.saved.original);
    const frame = capture.manifest.frames[0];
    const wall = {
      ...room.walls[0],
      id: "wall",
      transform: [...identityMatrix],
      dimensions: { width: 2, height: 2, depth: 0 },
    };
    wall.transform[12] = 2;
    wall.transform[13] = 1;
    wall.transform[14] = 2;
    room.walls = [wall];
    room.floors = [];
    room.openings = [];
    const depth = floatBuffer(capture.files[frame.depth]);
    depth.fill(2);
    const pixels = {
      width: 64,
      height: 64,
      data: new Uint8ClampedArray(64 * 64 * 4),
    };
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        pixels.data.set(
          x < 32 ? [200, 40, 30, 255] : [70, 90, 120, 255],
          (y * 64 + x) * 4,
        );
      }
    for (let y = 0; y < frame.depthHeight; y++)
      for (let x = 0; x < frame.depthWidth / 2; x++)
        depth[y * frame.depthWidth + x] = 1;
    capture.files[frame.depth] = new Uint8Array(depth.buffer);
    const values = observeSurfaceColors(capture, room, frame, pixels, 0);
    expect(values).toHaveLength(1);
    expect(values[0].color).toBe("#465a78");
    expect(values[0].side).toBe("front");
    expect(values[0].samples).toBe(50);
    room.openings = [{ ...wall, id: "door", kind: "door", parentId: "wall" }];
    expect(observeSurfaceColors(capture, room, frame, pixels, 0)).toEqual([]);
    room.openings = [];
    capture.files[frame.confidence].fill(0);
    expect(observeSurfaceColors(capture, room, frame, pixels, 0)).toEqual([]);
  });

  it("softens furniture without expanding measured bounds", () => {
    for (const fabric of [true, false]) {
      const geometry = roundedPartGeometry(
        [0.8, 0.12, 0.3],
        [1.6, 0.75, 2.1],
        fabric,
      );
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      expect(bounds.min.x).toBeGreaterThanOrEqual(-0.400001);
      expect(bounds.max.x).toBeLessThanOrEqual(0.400001);
      expect(bounds.min.y).toBeGreaterThanOrEqual(-0.060001);
      expect(bounds.max.y).toBeLessThanOrEqual(0.060001);
      expect(bounds.max.z).toBeLessThanOrEqual(0.150001);
      expect(
        Array.from(geometry.getAttribute("normal").array).every(
          Number.isFinite,
        ),
      ).toBe(true);
      geometry.dispose();
    }
  });
});

describe("bounded reconstruction generation", () => {
  it("overlaps batches, bounds concurrency, and preserves input order", async () => {
    let active = 0,
      peak = 0;
    const releases: Array<() => void> = [];
    const pending = mapConcurrent(
      [0, 1, 2, 3],
      2,
      async (value) => {
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => {
          releases[value] = resolve;
        });
        active--;
        return value * 2;
      },
      new AbortController().signal,
    );
    expect(active).toBe(2);
    releases[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(releases[2]).toBeDefined();
    releases[0]();
    releases[2]();
    await Promise.resolve();
    await Promise.resolve();
    releases[3]();
    expect(await pending).toEqual([0, 2, 4, 6]);
    expect(peak).toBe(2);
  });

  it("cancels siblings and stops scheduling after a failure", async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent(
        [0, 1, 2, 3],
        2,
        async (value, _i, signal) => {
          started.push(value);
          if (!value) throw new Error("provider failed");
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          return value;
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("provider failed");
    expect(started).toEqual([0, 1]);
  });
});
