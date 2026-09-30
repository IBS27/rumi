import { describe, expect, it } from "bun:test";
import {
  applyDesignCommands,
  designPlacementIssue,
  objectInZone,
  productObject,
} from "../shared/design";
import { importRoomPlan } from "../shared/capture/roomplan";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { buildSpaceModel, ringContains } from "../shared/planner/space";
import type {
  ProductCandidate,
  ReservedZone,
  RoomObject,
  RoomSnapshot,
} from "../shared/contracts";

// Synthetic RoomPlan captures: each wall runs between consecutive outline
// points; each floor is one polygon.
const frame = (x: number, y: number, z: number, yaw: number) => [
  Math.cos(yaw), 0, -Math.sin(yaw), 0,
  0, 1, 0, 0,
  Math.sin(yaw), 0, Math.cos(yaw), 0,
  x, y, z, 1,
];
const scan = (walls: number[][][], floors: number[][][]): RoomSnapshot =>
  importRoomPlan(
    {
      version: 2,
      objects: [],
      doors: [],
      windows: [],
      openings: [],
      walls: walls.map(([[x, z], [xx, zz]], i) => ({
        identifier: `wall-${i}`,
        dimensions: [Math.hypot(xx - x, zz - z), 2.7, 0],
        transform: frame((x + xx) / 2, 1.35, (z + zz) / 2, -Math.atan2(zz - z, xx - x)),
        category: { wall: {} },
        confidence: { high: {} },
        polygonCorners: [],
        parentIdentifier: null,
      })),
      floors: floors.map((outline, i) => ({
        identifier: `floor-${i}`,
        dimensions: [6, 6, 0],
        transform: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
        polygonCorners: outline.map(([x, z]) => [x, z, 0]),
        category: { floor: {} },
        confidence: { high: {} },
        parentIdentifier: null,
      })),
    },
    "Synthetic scan",
    true,
  );
const loop = (outline: number[][]) =>
  outline.map((point, i) => [point, outline[(i + 1) % outline.length]]);
const square = [[0, 0], [6, 0], [6, 6], [0, 6]];
const uShape = [[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]];
const squareScan = () => scan(loop(square), [square]);
const uScan = () => scan(loop(uShape), [uShape]);
// Two floor regions divided by a partition wall at x = 3.
const splitScan = () =>
  scan(
    [...loop([[0, 0], [6, 0], [6, 3], [0, 3]]), [[3, 0], [3, 3]]],
    [
      [[0, 0], [3, 0], [3, 3], [0, 3]],
      [[3, 0], [6, 0], [6, 3], [3, 3]],
    ],
  );

const [lampProduct, , , printProduct] = sampleProducts;
const lamp = productObject(lampProduct, "lamp");
const rectangle = { ...sampleRoom, objects: [] };
const captured = (extra: Partial<RoomObject>): RoomObject => ({
  id: "scanned",
  name: "Scanned cabinet",
  category: "storage",
  productId: null,
  assetId: null,
  dimensions: { width: 1, height: 0.8, depth: 0.6 },
  position: { x: 3, y: 0, z: 3 },
  rotation: { x: 0, y: 0, z: 0 },
  color: "#b7aea1",
  owned: true,
  locked: false,
  measurementSource: "estimated",
  ...extra,
});
const tryApply = (...args: Parameters<typeof applyDesignCommands>) => {
  try {
    return applyDesignCommands(...args);
  } catch (error) {
    return (error as Error).message;
  }
};
const wallZone = (
  position: ReservedZone["position"],
  rotationY: number,
): ReservedZone => ({
  id: "print-zone",
  purpose: "art",
  category: "art",
  query: "print",
  mount: "wall",
  anchor: "wall",
  relatedObjectId: null,
  position,
  rotationY,
  footprint: { width: 0.5, depth: 0.05 },
  maxHeight: 1.5,
  margins: { front: 0, back: 0, sides: 0 },
  clearanceRules: [],
  miscellaneous: [],
  priority: 1,
  suggested: false,
});
const onFloor = (room: RoomSnapshot, object: RoomObject) =>
  buildSpaceModel(room).floor.some((ring) => ringContains(ring, object.position));
const print = (position: RoomObject["position"], yaw: number): RoomObject => ({
  ...productObject(printProduct, "print"),
  mount: "wall",
  position,
  rotation: { x: 0, y: yaw, z: 0 },
});

describe("placement against measured boundaries", () => {
  it("lets a scanned piece overrun its scanned wall by scan noise only", () => {
    const room = squareScan();
    // 10 cm past the west wall is scan noise; 25 cm is a real overrun.
    expect(designPlacementIssue(room, captured({ position: { x: 0.4, y: 0, z: 3 } }))).toBeNull();
    expect(designPlacementIssue(room, captured({ position: { x: 0.25, y: 0, z: 3 } }))).toContain(
      "floor boundary",
    );
  });

  it("measures a tilted scanned piece by its full transformed footprint", () => {
    const room = squareScan();
    // A 2 m tall piece rolled 45° leans 1.56 m west of its base center; its
    // yaw-only rectangle would sit well inside the room.
    const tilted = (x: number) =>
      captured({
        dimensions: { width: 0.4, height: 2, depth: 0.4 },
        position: { x, y: 0.2, z: 1 },
        rotation: { x: 0, y: 0, z: Math.PI / 4 },
      });
    expect(designPlacementIssue(room, tilted(0.3))).toContain("floor boundary");
    expect(designPlacementIssue(room, tilted(1.456))).toBeNull();
    expect(designPlacementIssue(room, tilted(1.306))).toContain("floor boundary");
    // The public scan-correction path applies the same check.
    const scanned = { ...room, objects: [tilted(3)] };
    expect(
      tryApply(scanned, [{ type: "correct", object: tilted(0.3) }], sampleProducts, sampleBrief),
    ).toContain("floor boundary");
    const corrected = tryApply(
      scanned,
      [{ type: "correct", object: tilted(1.456) }],
      sampleProducts,
      sampleBrief,
    );
    expect(typeof corrected).not.toBe("string");
  });

  it("does not let a tolerated piece bridge a concave cutout", () => {
    const room = uScan();
    // Both ends rest in the U's arms; the middle spans the 2 m cutout.
    const bridge = captured({
      dimensions: { width: 2.2, height: 0.8, depth: 0.3 },
      position: { x: 3, y: 0, z: 4 },
    });
    expect(designPlacementIssue(room, bridge)).toContain("floor boundary");
  });

  it("checks catalog products and confirmed rooms exactly", () => {
    // The lamp is 0.45 m wide: centred at x = 0.1 it is 12.5 cm through the wall.
    const overrun = { ...lamp, position: { x: 0.1, y: 0, z: 2 } };
    expect(designPlacementIssue(rectangle, overrun)).toContain("floor boundary");
    expect(
      tryApply(
        rectangle,
        [{ type: "add", productId: lampProduct.id, instanceId: "lamp", position: overrun.position }],
        sampleProducts,
        sampleBrief,
      ),
    ).toContain("floor boundary");
    // A confirmed rectangle is authoritative even for owned furniture.
    const owned = captured({
      dimensions: { width: 0.45, height: 1.5, depth: 0.45 },
      position: { x: 0.1, y: 0, z: 2 },
    });
    expect(designPlacementIssue(rectangle, owned)).toContain("floor boundary");
    // In a scan, the same overrun is noise for a scanned piece but not for a
    // new product, whose size is not a scan estimate.
    const room = squareScan();
    expect(designPlacementIssue(room, owned)).toBeNull();
    expect(designPlacementIssue(room, overrun)).toContain("floor boundary");
  });

  it("still fits a slightly larger planned product at its reservation", () => {
    const queen: ProductCandidate = {
      ...lampProduct,
      id: "queen",
      name: "Queen bed",
      category: "bed",
      measurement: {
        ...lampProduct.measurement,
        dimensions: { width: 1.6, height: 0.6, depth: 2.11 },
      },
    };
    const bedZone: ReservedZone = {
      ...wallZone({ x: 2, y: 0, z: 1.2 }, 0),
      id: "bed-zone",
      purpose: "bed",
      category: "bed",
      mount: "floor",
      footprint: { width: 1.6, depth: 2.1 },
      maxHeight: 2.6,
    };
    const bed = objectInZone(rectangle, queen, "bed", bedZone);
    expect(bed.position).toEqual({ x: 2, y: 0, z: 1.2 });
    expect(designPlacementIssue(rectangle, bed)).toBeNull();
    // A lamp whose reservation overlaps another slides to a clear spot.
    const occupied = { ...rectangle, objects: [{ ...lamp, position: { x: 2, y: 0, z: 2 } }] };
    const lampZone = { ...bedZone, id: "lamp-zone", category: "lighting", position: { x: 2.43, y: 0, z: 2 }, footprint: { width: 0.45, depth: 0.45 } };
    const slid = objectInZone(occupied, lampProduct, "second-lamp", lampZone);
    expect(slid.position.x).toBeGreaterThan(2.43);
    expect(designPlacementIssue(occupied, slid)).toBeNull();
  });
});

describe("wall pieces in measured rooms", () => {
  it("hangs art on the room side of a concave room's wall", () => {
    const room = uScan();
    // The print hangs on the left arm's inner wall at x = 2; the U's cutout
    // lies east of that wall, the arm's floor west of it.
    for (const yaw of [-Math.PI / 2, Math.PI / 2]) {
      const placed = objectInZone(room, printProduct, "art", wallZone({ x: 1.975, y: 1, z: 4 }, yaw));
      expect(placed.position.x).toBeCloseTo(1.97);
      expect(placed.rotation.y).toBeCloseTo(-Math.PI / 2);
      expect(onFloor(room, placed)).toBe(true);
      expect(designPlacementIssue(room, placed)).toBeNull();
    }
    const next = tryApply(
      room,
      [{ type: "add", productId: printProduct.id, instanceId: "art", zone: wallZone({ x: 1.975, y: 1, z: 4 }, -Math.PI / 2) }],
      sampleProducts,
      sampleBrief,
    );
    if (typeof next === "string") throw new Error(next);
    expect(onFloor(room, next.objects[0])).toBe(true);
    // Moving it onto the cutout side of the same wall is rejected.
    expect(
      designPlacementIssue(room, print({ x: 2.03, y: 1, z: 4 }, Math.PI / 2)),
    ).toContain("against a wall");
    expect(
      tryApply(
        next,
        [{ type: "move", objectId: "art", position: { x: 2.03, y: 1, z: 4 }, rotationY: Math.PI / 2 }],
        sampleProducts,
        sampleBrief,
      ),
    ).toContain("against a wall");
  });

  it("keeps each side of a partition between floor regions", () => {
    const room = splitScan();
    const east = objectInZone(room, printProduct, "east", wallZone({ x: 3.1, y: 1, z: 1.5 }, Math.PI / 2));
    const west = objectInZone(room, printProduct, "west", wallZone({ x: 2.9, y: 1, z: 1.5 }, -Math.PI / 2));
    expect(east.position.x).toBeCloseTo(3.03);
    expect(east.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(west.position.x).toBeCloseTo(2.97);
    expect(west.rotation.y).toBeCloseTo(-Math.PI / 2);
    expect(designPlacementIssue(room, east)).toBeNull();
    expect(designPlacementIssue(room, west)).toBeNull();
    // Hung on the outer north wall, a print may not run across the partition.
    expect(designPlacementIssue(room, print({ x: 3.05, y: 1, z: 0.03 }, 0))).toContain("crosses a wall");
    expect(designPlacementIssue(room, print({ x: 2.5, y: 1, z: 0.03 }, 0))).toBeNull();
  });

  it("rejects art outside, behind or facing a confirmed wall, and over openings", () => {
    // North wall at z = 0; the room lies south of it.
    expect(designPlacementIssue(rectangle, print({ x: 2, y: 1, z: 0.03 }, 0))).toBeNull();
    expect(designPlacementIssue(rectangle, print({ x: 2, y: 1, z: -0.03 }, 0))).toContain("against a wall");
    expect(designPlacementIssue(rectangle, print({ x: 2, y: 1, z: 0.03 }, Math.PI))).toContain("against a wall");
    expect(
      tryApply(
        rectangle,
        [{ type: "add", productId: printProduct.id, instanceId: "print", position: { x: 2, y: 1, z: -0.03 }, rotationY: 0, zone: wallZone({ x: 2, y: 1, z: 0.025 }, 0) }],
        sampleProducts,
        sampleBrief,
      ),
    ).toContain("against a wall");
    // The sample window spans x = 2.7..4.1 on the north wall.
    expect(designPlacementIssue(rectangle, print({ x: 3, y: 1, z: 0.03 }, 0))).toContain("door or window");
  });

  it("checks a hung piece's full tilted footprint against its own wall", () => {
    const hung = tryApply(
      rectangle,
      [{ type: "add", productId: printProduct.id, instanceId: "art", zone: wallZone({ x: 2, y: 1, z: 0.03 }, 0) }],
      sampleProducts,
      sampleBrief,
    );
    if (typeof hung === "string") throw new Error(hung);
    const art = hung.objects[0];
    expect(art.position).toEqual({ x: 2, y: 1, z: 0.03 });
    const correct = (rotation: RoomObject["rotation"]) =>
      tryApply(hung, [{ type: "correct", object: { ...art, rotation } }], sampleProducts, sampleBrief);
    // Pitched back, the print's top passes 17.5 cm (or 48 cm) through the wall.
    expect(correct({ x: -Math.PI / 12, y: 0, z: 0 })).toContain("wall");
    expect(correct({ x: -Math.PI / 4, y: 0, z: 0 })).toContain("wall");
    // Turned 0.1 rad about its center, one end goes 2 cm behind the wall.
    expect(
      tryApply(hung, [{ type: "move", objectId: "art", position: art.position, rotationY: 0.1 }], sampleProducts, sampleBrief),
    ).toContain("wall");
    // Leaning its top out into the room keeps it in front of the wall.
    const leaning = correct({ x: Math.PI / 24, y: 0, z: 0 });
    if (typeof leaning === "string") throw new Error(leaning);
    expect(leaning.objects[0].rotation.x).toBeCloseTo(Math.PI / 24);
  });

  it("snaps corner art clear of the neighbouring wall", () => {
    const placed = objectInZone(rectangle, printProduct, "corner", wallZone({ x: 0.1, y: 1, z: 0.03 }, 0));
    expect(placed.position.z).toBeCloseTo(0.03);
    expect(placed.position.x).toBeGreaterThanOrEqual(0.25);
    expect(designPlacementIssue(rectangle, placed)).toBeNull();
  });
});
