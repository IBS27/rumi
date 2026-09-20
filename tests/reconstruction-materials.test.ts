import { describe, expect, it } from "bun:test";
import { BoxGeometry, CylinderGeometry, ShapeGeometry } from "three";
import { materialDetailSchema } from "../shared/assets/materials";
import { finishRegionShapes } from "../shared/reconstruction/surfaces";
import {
  materialPixels,
  applyMeterUVs,
} from "../src/features/room-editor/reconstruction/materials";
import type { CapturedSurface } from "../shared/contracts";
import { identityMatrix } from "./fixtures/capture-package";

describe("reconstructed materials", () => {
  it("clips finish regions to measured surfaces without covering doorways", () => {
    const wall: CapturedSurface = {
      id: "wall",
      kind: "wall",
      parentId: null,
      dimensions: { width: 4, height: 3, depth: 0.1 },
      transform: [...identityMatrix],
      polygonCorners: [],
      confidence: "high",
    };
    const door: CapturedSurface = {
      ...wall,
      id: "door",
      kind: "door",
      parentId: "wall",
      dimensions: { width: 1, height: 2, depth: 0 },
      transform: [...identityMatrix],
    };
    door.transform[13] = -0.5;
    const shapes = finishRegionShapes(
      wall,
      [door],
      [
        { x: -20, y: -20 },
        { x: 20, y: -20 },
        { x: 20, y: 20 },
        { x: -20, y: 20 },
      ],
    );
    const geometry = new ShapeGeometry(shapes);
    const positions = geometry.getAttribute("position"),
      indices = geometry.getIndex()!;
    let area = 0;
    for (let i = 0; i < indices.count; i += 3) {
      const a = indices.getX(i),
        b = indices.getX(i + 1),
        c = indices.getX(i + 2);
      const ax = positions.getX(a),
        ay = positions.getY(a);
      const bx = positions.getX(b),
        by = positions.getY(b);
      const cx = positions.getX(c),
        cy = positions.getY(c);
      area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      const x = (ax + bx + cx) / 3,
        y = (ay + by + cy) / 3;
      expect(Math.abs(x) < 0.5 && y < 0.5 && y > -1.5).toBe(false);
    }
    expect(area).toBeCloseTo(10, 5);
    expect(
      finishRegionShapes(
        wall,
        [],
        [
          { x: 10, y: 10 },
          { x: 11, y: 10 },
          { x: 11, y: 11 },
        ],
      ),
    ).toHaveLength(0);
    geometry.dispose();
  });

  it("keeps grain in physical meters across resizes and repeated updates", () => {
    const box = new BoxGeometry(1, 1, 1);
    applyMeterUVs(box, [2, 3, 4], "box");
    const uv = box.getAttribute("uv");
    // The +X face spans the 4m depth and 3m height, rather than a unit square.
    expect(Math.abs(uv.getX(0) - uv.getX(1))).toBe(4);
    expect(Math.abs(uv.getY(0) - uv.getY(2))).toBe(3);
    const cylinder = new CylinderGeometry(0.5, 0.5, 1, 12);
    applyMeterUVs(cylinder, [0.5, 2, 0.5], "cylinder");
    const first = Array.from(cylinder.getAttribute("uv").array);
    applyMeterUVs(cylinder, [0.5, 2, 0.5], "cylinder");
    expect(Array.from(cylinder.getAttribute("uv").array)).toEqual(first);
    applyMeterUVs(cylinder, [1, 4, 1], "cylinder");
    expect(Array.from(cylinder.getAttribute("uv").array)).toEqual(
      first.map((v) => v * 2),
    );
    box.dispose();
    cylinder.dispose();
  });

  it("adds neutral tile detail without baking a photograph or tint into the material", () => {
    const detail = materialDetailSchema.parse({
      texture: "tile",
      repeatWidth: 0.6,
      repeatHeight: 0.3,
      roughness: 0.45,
    });
    const pixels = materialPixels(detail, 64);
    expect(pixels).toEqual(materialPixels(detail, 64));
    expect(pixels[0]).toBeLessThan(pixels[(32 * 64 + 32) * 4]);
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(pixels[i + 1]);
      expect(pixels[i]).toBe(pixels[i + 2]);
      expect(pixels[i + 3]).toBe(255);
    }
    expect(
      materialDetailSchema.safeParse({ ...detail, repeatWidth: 0 }).success,
    ).toBe(false);
    expect(
      materialDetailSchema.safeParse({
        texture: "plain",
        repeatWidth: 0,
        repeatHeight: 0,
        roughness: 0.2,
      }).success,
    ).toBe(true);
  });
});
