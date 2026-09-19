import { describe, expect, it } from "bun:test";
import { Matrix4, ShapeGeometry, Vector3 } from "three";
import { importRoomPlan, parseRoomFile } from "../shared/capture/roomplan";
import { floorArea, surfaceShape } from "../shared/capture/surfaces";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { findPlacement, placementIssue } from "../shared/geometry";
import { sampleProducts } from "../shared/fixtures";

describe("RoomPlan import", () => {
  it("preserves an L-shaped floor, openings, object sizes, and base positions", () => {
    const room = importRoomPlan(syntheticRoomPlan);
    expect(room.walls).toHaveLength(6);
    expect(room.openings[0].parentId).toBe("sample-wall-4");
    expect(floorArea(room.floors)).toBeCloseTo(5.8 * 4.6 - 2 * 1.4);
    expect(room.objects[0].dimensions).toEqual({
      width: 2.15,
      height: 0.85,
      depth: 0.92,
    });
    expect(room.objects[0].position.y).toBeCloseTo(0);
    expect(room.objects[0].rotation.y).toBeCloseTo(Math.PI / 2);
    expect(room.measurementSource).toBe("estimated");
  });
  it("removes a translated scan origin without mirroring or swapping dimensions", () => {
    const scan = structuredClone(syntheticRoomPlan);
    for (const item of [
      ...scan.walls,
      ...scan.floors,
      ...scan.doors,
      ...scan.windows,
      ...scan.objects,
    ]) {
      item.transform[12] += 15;
      item.transform[13] -= 3;
      item.transform[14] += 8;
    }
    const actual = importRoomPlan(scan),
      expected = importRoomPlan(syntheticRoomPlan);
    expect(actual.capture.origin.x).toBeCloseTo(15);
    expect(actual.capture.origin.y).toBeCloseTo(-3);
    expect(actual.capture.origin.z).toBeCloseTo(8);
    expect(actual.objects[0].position.x).toBeCloseTo(
      expected.objects[0].position.x,
    );
    expect(actual.objects[0].position.y).toBeCloseTo(0);
    expect(actual.objects[0].position.z).toBeCloseTo(
      expected.objects[0].position.z,
    );
  });
  it("computes a tilted object's base in its local frame", () => {
    const scan = structuredClone(syntheticRoomPlan);
    scan.objects[0].transform = new Matrix4()
      .makeRotationZ(0.2)
      .setPosition(1, 1, 1)
      .toArray();
    const room = importRoomPlan(scan);
    const base = new Vector3(0, -0.85 / 2, 0).applyMatrix4(
      new Matrix4().fromArray(scan.objects[0].transform),
    );
    expect(room.objects[0].position.x).toBeCloseTo(base.x);
    expect(room.objects[0].position.y).toBeCloseTo(base.y);
  });
  it("keeps source fields for round trips and leaves original measurements unchanged", () => {
    const raw = {
      ...syntheticRoomPlan,
      coreModel: "opaque",
      futureField: { value: 12 },
    };
    const imported = parseRoomFile(JSON.stringify(raw), "scan.json");
    imported.room.objects[0].dimensions.width = 3;
    const restored = parseRoomFile(JSON.stringify(imported), "saved.json");
    expect(restored.room.objects[0].dimensions.width).toBe(3);
    expect(JSON.stringify(restored.original)).toBe(
      JSON.stringify(imported.original),
    );
    expect(restored.original.coreModel).toBe("opaque");
    expect(restored.original.objects[0].dimensions[0]).toBe(2.15);
    expect(restored.original.objects[0].attributes).toEqual({});
  });
  it("reports missing floors and preserves unknown categories", () => {
    const scan = {
      ...syntheticRoomPlan,
      floors: undefined,
      objects: [{ ...syntheticRoomPlan.objects[0], category: { piano: {} } }],
    };
    const room = importRoomPlan(scan);
    expect(room.floors).toHaveLength(0);
    expect(room.objects[0].category).toBe("unknown");
    expect(room.objects[0].sourceCategory).toBe("piano");
    expect(room.capture.warnings.join(" ")).toContain("no floor polygon");
  });
  it("rejects malformed files, scaled transforms, duplicates, and invalid dimensions", () => {
    expect(() => parseRoomFile("not json", "bad.json")).toThrow("valid JSON");
    const scaled = structuredClone(syntheticRoomPlan);
    scaled.objects[0].transform[0] = 10;
    expect(() => importRoomPlan(scaled)).toThrow("transform");
    const duplicate = structuredClone(syntheticRoomPlan);
    duplicate.objects.push(duplicate.objects[0]);
    expect(() => importRoomPlan(duplicate)).toThrow("duplicate");
    const invalid = structuredClone(syntheticRoomPlan);
    invalid.objects[0].dimensions[0] = -1;
    expect(() => importRoomPlan(invalid)).toThrow("dimensions");
  });
  it("cuts the door out of the wall and does not fill the floor's recess", () => {
    const room = importRoomPlan(syntheticRoomPlan);
    const geometry = new ShapeGeometry(
      surfaceShape(room.walls[4], room.openings),
    );
    const positions = geometry.getAttribute("position"),
      indices = geometry.index!;
    let area = 0;
    for (let i = 0; i < indices.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(positions, indices.getX(i));
      const b = new Vector3().fromBufferAttribute(
        positions,
        indices.getX(i + 1),
      );
      const c = new Vector3().fromBufferAttribute(
        positions,
        indices.getX(i + 2),
      );
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    expect(area).toBeCloseTo(3.8 * 2.7 - 0.9 * 2.1, 4);
    geometry.dispose();
  });
  it("does not apply rectangle fit checks to irregular scans", () => {
    const room = importRoomPlan(syntheticRoomPlan);
    expect(findPlacement(room, sampleProducts[0])).toBeNull();
    expect(placementIssue(room, room.objects[0])).toContain("not available");
  });
});

it("rejects saved files with corrupt originals or surface transforms before opening", () => {
  const saved = parseRoomFile(JSON.stringify(syntheticRoomPlan), "scan.json");
  saved.original.objects[0].dimensions[0] = -1;
  expect(() => parseRoomFile(JSON.stringify(saved), "saved.json")).toThrow(
    "original scan is invalid",
  );
  const invalid = parseRoomFile(JSON.stringify(syntheticRoomPlan), "scan.json");
  if (invalid.room.shape !== "polygon")
    throw new Error("Expected captured room");
  invalid.room.walls[0].transform[0] = 10;
  expect(() => parseRoomFile(JSON.stringify(invalid), "saved.json")).toThrow(
    "surface geometry",
  );
});
