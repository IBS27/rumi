import { describe, expect, it } from "bun:test";
import { Matrix4 } from "three";
import { searchTaskSchema, type ZonePlanRequest } from "../shared/contracts";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { importRoomPlan, localCorners } from "../shared/capture/roomplan";
import { placementIssue } from "../shared/geometry";
import { sameCategory } from "../shared/planner/scope";
import { designPlacementIssue, objectInZone } from "../shared/design/placement";
import {
  SPACING_FACTOR,
  allocateBudget,
  buildDesignPlan,
  buildSpaceModel,
  describeScope,
  evaluateFill,
  excludeTagsFor,
  marginsFor,
  planScope,
  reserveZones,
  scaleMargins,
} from "../shared/planner";
import {
  freeArea,
  freeSpaceContains,
  polygonArea,
  rectangleRing,
  ringInside,
  ringsOverlap,
} from "../shared/planner/space";

const lampZone = {
  id: "reading-light",
  purpose: "reading light beside the bed",
  category: "floor lamp",
  query: "arc floor lamp",
  mount: "floor" as const,
  anchor: "near-object" as const,
  relatedObjectId: "owned-bed",
  desiredFootprint: { width: 0.5, depth: 0.5 },
  desiredHeight: 1.8,
  miscellaneous: ["warm light"],
  priority: 1,
};

const request: ZonePlanRequest = {
  summary: "Add warm lighting and a rug around the existing bed.",
  spacing: "balanced",
  zones: [
    lampZone,
    {
      id: "rug",
      purpose: "soft landing beside the bed",
      category: "rug",
      query: "wool area rug",
      mount: "under",
      anchor: "center",
      relatedObjectId: null,
      desiredFootprint: { width: 1.6, depth: 2.2 },
      desiredHeight: null,
      miscellaneous: [],
      priority: 2,
    },
  ],
};

describe("space model", () => {
  it("measures a rectangle room in meters and removes furniture and door clearance", () => {
    const model = buildSpaceModel(sampleRoom);
    expect(model.units).toBe("meters");
    expect(polygonArea(model.floor)).toBeCloseTo(4.8 * 4.2, 5);
    expect(model.obstacles.map((obstacle) => obstacle.id)).toEqual([
      "owned-bed",
      "owned-desk",
    ]);
    expect(model.clearances).toHaveLength(1);
    const bed = sampleRoom.objects[0];
    expect(
      freeSpaceContains(model, { x: bed.position.x, z: bed.position.z }),
    ).toBe(false);
    expect(freeSpaceContains(model, { x: 0.7, z: 4.0 })).toBe(false);
    expect(freeSpaceContains(model, { x: 3.5, z: 3.0 })).toBe(true);
    expect(freeArea(model)).toBeLessThan(polygonArea(model.floor));
    expect(freeArea(model)).toBeGreaterThan(5);
  });

  it("uses rotated footprints for scanned furniture in polygon rooms", () => {
    const room = importRoomPlan(syntheticRoomPlan);
    const model = buildSpaceModel(room);
    expect(model.shape).toBe("polygon");
    expect(polygonArea(model.floor)).toBeCloseTo(5.8 * 4.6 - 2 * 1.4, 3);
    const sofa = model.obstacles.find((obstacle) => obstacle.id === "sample-sofa");
    expect(sofa).toBeDefined();
    const xs = sofa!.footprint.map((point) => point.x);
    const zs = sofa!.footprint.map((point) => point.z);
    // The sofa is rotated a quarter turn, so its long side runs along Z.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(2.15, 2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.92, 2);
    expect(model.walls.length).toBe(6);
    expect(model.clearances).toHaveLength(1);
  });

  it("preserves scanned opening spans regardless of rotation and corner order", () => {
    for (const yaw of [0, Math.PI / 2, 0.7]) {
      for (const polygon of [false, true]) {
        const room = importRoomPlan(syntheticRoomPlan);
        const rotation = new Matrix4().makeRotationY(yaw);
        for (const surface of [...room.walls, ...room.openings, ...room.floors]) {
          surface.transform = rotation.clone()
            .multiply(new Matrix4().fromArray(surface.transform)).toArray();
          if (polygon && surface.kind !== "floor") {
            const corners = localCorners(surface).map(({ x, y, z }) => ({ x, y, z }));
            surface.polygonCorners = [...corners.slice(2), ...corners.slice(0, 2)];
          }
        }
        const model = buildSpaceModel(room);
        for (const wall of model.walls) {
          const surface = room.walls.find((item) => item.id === wall.id)!;
          expect(Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z))
            .toBeCloseTo(surface.dimensions.width, 6);
          for (const opening of wall.openings) {
            const captured = room.openings.find((item) => item.parentId === wall.id)!;
            expect(Math.hypot(opening.end.x - opening.start.x, opening.end.z - opening.start.z))
              .toBeCloseTo(captured.dimensions.width, 6);
          }
        }
      }
    }
  });

  it("detects overlap between rotated rectangles", () => {
    const a = rectangleRing({ x: 1, z: 1 }, 1, 1, 0);
    const b = rectangleRing({ x: 1.6, z: 1 }, 1, 0.4, Math.PI / 4);
    const c = rectangleRing({ x: 3, z: 3 }, 1, 1, 0);
    expect(ringsOverlap(a, b)).toBe(true);
    expect(ringsOverlap(a, c)).toBe(false);
  });

  it("rotates door access with the measured aperture without widening past both jambs", () => {
    const room = importRoomPlan(syntheticRoomPlan);
    const original = buildSpaceModel(room).clearances[0];
    const yaw = 0.63;
    const rotation = new Matrix4().makeRotationY(yaw);
    for (const surface of [...room.floors, ...room.walls, ...room.openings])
      surface.transform = rotation.clone()
        .multiply(new Matrix4().fromArray(surface.transform)).toArray();
    const rotated = buildSpaceModel(room).clearances[0];
    // Aperture 0.9 m plus a 0.3 m shoulder past each jamb, 0.9 m approach both sides.
    expect(polygonArea([rotated.footprint])).toBeCloseTo(1.5 * 1.8, 6);
    for (const point of original.footprint) {
      const expected = {
        x: point.x * Math.cos(yaw) + point.z * Math.sin(yaw),
        z: -point.x * Math.sin(yaw) + point.z * Math.cos(yaw),
      };
      expect(rotated.footprint.some((actual) =>
        Math.hypot(actual.x - expected.x, actual.z - expected.z) < 1e-6,
      )).toBe(true);
    }
  });
});

describe("zone reservation", () => {
  it("finds frame-sized beds along angled, inset scan floors without removal history", () => {
    for (const yaw of [0.0655, 0.63, -0.8]) {
      const scan = importRoomPlan(syntheticRoomPlan);
      const transform = new Matrix4().makeTranslation(2, 0, 2)
        .multiply(new Matrix4().makeRotationY(yaw))
        .multiply(new Matrix4().fromArray(scan.floors[0].transform));
      const room = {
        ...scan, walls: [], openings: [], objects: [],
        floors: [{ ...scan.floors[0], transform: transform.toArray(),
          polygonCorners: [
            { x: 0, y: 0, z: 0 }, { x: 2.9, y: 0, z: 0 },
            { x: 2.9, y: 3, z: 0 }, { x: 0, y: 3, z: 0 },
          ],
        }],
      };
      const model = buildSpaceModel(room);
      const desiredFootprint = { width: 1.65, depth: 2.15 };
      const result = reserveZones(room, model, [{
        ...lampZone, id: "bed", category: "bed", query: "queen bed",
        relatedObjectId: null, anchor: "wall", desiredFootprint,
      }]);
      expect(result.rejected).toEqual([]);
      const zone = result.zones[0];
      expect(zone.footprint).toEqual(desiredFootprint);
      expect(Math.abs(Math.sin(zone.rotationY - yaw))).toBeLessThan(1e-6);
      expect(ringInside(rectangleRing(zone.position, 1.65, 2.15, zone.rotationY), model.floor)).toBe(true);
      expect(designPlacementIssue(room, {
        ...sampleRoom.objects[0], owned: false,
        position: zone.position, rotation: { x: 0, y: zone.rotationY, z: 0 },
        dimensions: { ...desiredFootprint, height: 1 },
      })).toBeNull();
    }
  });

  it("does not stand furniture against floor edges that have no wall behind them", () => {
    const scan = importRoomPlan(syntheticRoomPlan);
    // One square floor patch; only the east edge has a scanned wall. The
    // other three edges are scan cutoffs, not walls.
    const floorPatch = {
      ...scan.floors[0],
      transform: new Matrix4().toArray(),
      polygonCorners: [
        { x: 0, y: 0, z: 0 },
        { x: 4.4, y: 0, z: 0 },
        { x: 4.4, y: 0, z: 4 },
        { x: 0, y: 0, z: 4 },
      ],
    };
    const eastWall = {
      ...scan.walls[0],
      dimensions: { width: 4, height: 2.5, depth: 0 },
      polygonCorners: [],
      transform: new Matrix4()
        .makeRotationY(-Math.PI / 2)
        .setPosition(4.4, 1.2, 2)
        .toArray(),
    };
    const room = {
      ...scan,
      floors: [floorPatch],
      walls: [eastWall],
      openings: [],
      objects: [],
    };
    const { zones, rejected } = reserveZones(room, buildSpaceModel(room), [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        relatedObjectId: null,
        anchor: "wall",
        desiredFootprint: { width: 1.65, depth: 2.15 },
      },
    ]);
    expect(rejected).toEqual([]);
    const zone = zones[0];
    // Flush to the real wall on the east edge — not floating at a cutoff.
    expect(Math.abs(Math.abs(zone.rotationY) - Math.PI / 2)).toBeLessThan(0.01);
    expect(zone.position.x).toBeGreaterThan(3);
    expect(
      designPlacementIssue(room, {
        ...sampleRoom.objects[0],
        owned: false,
        position: zone.position,
        rotation: { x: 0, y: zone.rotationY, z: 0 },
        dimensions: { ...zone.footprint, height: 1 },
      }),
    ).toBeNull();
  });

  it("allows a bed walkway to share door access but never puts its body there", () => {
    const room = { ...sampleRoom, objects: [], openings: [] };
    const model = buildSpaceModel(room);
    model.clearances = [{
      id: "door", kind: "door", reason: "Keep the doorway open",
      footprint: rectangleRing({ x: 2.4, z: 2.45 }, 4.8, 0.5),
    }];
    const result = reserveZones(room, model, [{
      ...lampZone, id: "bed", category: "bed", query: "queen bed",
      relatedObjectId: null, anchor: "wall",
      desiredFootprint: { width: 1.65, depth: 2.1 },
    }]);
    expect(result.rejected).toEqual([]);
    const zone = result.zones[0];
    const body = rectangleRing(zone.position, zone.footprint.width, zone.footprint.depth, zone.rotationY);
    expect(ringsOverlap(body, model.clearances[0].footprint)).toBe(false);
    const front = rectangleRing({
      x: zone.position.x,
      z: zone.position.z + zone.footprint.depth / 2 + zone.margins.front / 2,
    }, zone.footprint.width, zone.margins.front);
    expect(ringsOverlap(front, model.clearances[0].footprint)).toBe(true);
    model.clearances[0].footprint = model.floor[0];
    expect(reserveZones(room, model, [{
      ...lampZone, id: "bed", category: "bed", query: "bed",
      relatedObjectId: null, desiredFootprint: { width: 1.65, depth: 2.15 },
    }]).zones).toEqual([]);
  });

  it("does not hang art across a scanned window", () => {
    const scan = importRoomPlan(syntheticRoomPlan);
    const room = { ...scan, objects: [], walls: [scan.walls[0]] };
    const requests = Array.from({ length: 4 }, (_, index) => ({
      ...lampZone,
      id: `art-${index}`,
      category: "wall art",
      mount: "wall" as const,
      relatedObjectId: null,
      desiredFootprint: { width: 1, depth: 0.04 },
      priority: index + 1,
    }));
    const result = reserveZones(room, buildSpaceModel(room), requests);
    expect(result.zones.length).toBeGreaterThan(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    // The sample window spans x=2.8..4.6 on the north wall.
    for (const zone of result.zones) {
      const left = zone.position.x - zone.footprint.width / 2;
      const right = zone.position.x + zone.footprint.width / 2;
      expect(right <= 2.8 || left >= 4.6).toBe(true);
    }
  });

  it("reserves zones with margins, away from furniture and doors", () => {
    const model = buildSpaceModel(sampleRoom);
    const { zones, rejected } = reserveZones(sampleRoom, model, request.zones);
    expect(rejected).toEqual([]);
    expect(zones.map((zone) => zone.id)).toEqual(["reading-light", "rug"]);
    for (const zone of zones) {
      const object = {
        id: `test-${zone.id}`,
        name: zone.purpose,
        category: zone.category === "rug" ? ("rug" as const) : ("lighting" as const),
        productId: null,
        assetId: null,
        dimensions: {
          width: zone.footprint.width,
          height: 0.5,
          depth: zone.footprint.depth,
        },
        position: zone.position,
        rotation: { x: 0, y: zone.rotationY, z: 0 },
        color: "#ffffff",
        owned: false,
        locked: false,
      };
      expect(placementIssue(sampleRoom, object)).toBeNull();
    }
    expect(zones[0].margins).toEqual(marginsFor("floor lamp"));
    expect(zones[0].maxHeight).toBeLessThan(sampleRoom.dimensions.height);
  });

  it("lets a rug share floor with reserved furniture but not the doorway", () => {
    const room = { ...sampleRoom, objects: [] };
    const model = buildSpaceModel(room);
    const { zones, rejected } = reserveZones(room, model, [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: { width: 1.6, depth: 2.1 },
        desiredHeight: null,
      },
      {
        ...lampZone,
        id: "rug",
        category: "area rug",
        query: "wool rug",
        anchor: "center",
        relatedObjectId: null,
        desiredFootprint: { width: 2.4, depth: 1.7 },
        desiredHeight: null,
        priority: 2,
      },
    ]);
    expect(rejected).toEqual([]);
    expect(zones.map((zone) => zone.id)).toEqual(["bed", "rug"]);
    const door = model.clearances[0].footprint;
    const rug = zones[1];
    const rugRing = rectangleRing(
      { x: rug.position.x, z: rug.position.z },
      rug.footprint.width,
      rug.footprint.depth,
      rug.rotationY,
    );
    expect(ringsOverlap(rugRing, door)).toBe(false);
  });

  it("shrinks a zone that is too large and rejects one that cannot fit", () => {
    const model = buildSpaceModel(sampleRoom);
    const { zones, rejected } = reserveZones(sampleRoom, model, [
      {
        ...lampZone,
        id: "big-table",
        category: "dining table",
        query: "dining table",
        anchor: "center",
        relatedObjectId: null,
        desiredFootprint: { width: 2.4, depth: 1.2 },
        desiredHeight: null,
      },
      {
        ...lampZone,
        id: "impossible",
        category: "wardrobe",
        query: "wardrobe",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: { width: 4.7, depth: 2 },
        priority: 2,
      },
    ]);
    const table = zones.find((zone) => zone.id === "big-table");
    if (table) expect(table.footprint.width).toBeLessThanOrEqual(2.4);
    expect(rejected.map((item) => item.zoneId)).toContain("impossible");
  });

  it("uses the captured floor bounds and keeps a full-size bed instead of shrinking it", () => {
    const scan = importRoomPlan(syntheticRoomPlan);
    const transform = [...scan.floors[0].transform];
    transform[12] = 0.2;
    transform[14] = 0.2;
    const room = {
      ...scan,
      dimensions: { width: 4.4, height: 2.7, depth: 3.4 },
      walls: [],
      openings: [],
      objects: [],
      floors: [
        {
          ...scan.floors[0],
          transform,
          polygonCorners: [
            { x: 0, y: 0, z: 0 },
            { x: 4, y: 0, z: 0 },
            { x: 4, y: 3, z: 0 },
            { x: 0, y: 3, z: 0 },
          ],
        },
      ],
    };
    const desiredFootprint = { width: 1.65, depth: 2.15 };
    const { zones, rejected } = reserveZones(room, buildSpaceModel(room), [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint,
        desiredHeight: null,
      },
    ]);
    expect(rejected).toEqual([]);
    expect(zones[0].footprint).toEqual(desiredFootprint);
    expect(zones[0].position.z).toBeGreaterThan(1.3);
  });

  it("finds a full-size bed slot with exactly 60 cm beside storage", () => {
    const room = {
      ...sampleRoom,
      dimensions: { width: 3.35, height: 2.7, depth: 3.2 },
      openings: [],
      objects: [
        {
          ...sampleRoom.objects[1],
          id: "storage",
          name: "Storage",
          category: "storage" as const,
          dimensions: { width: 0.5, height: 0.85, depth: 0.5 },
          position: { x: 3.1, y: 0, z: 0.3 },
        },
      ],
    };
    const desiredFootprint = { width: 1.65, depth: 2.15 };
    const { zones, rejected } = reserveZones(room, buildSpaceModel(room), [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint,
        desiredHeight: null,
      },
    ]);
    expect(rejected).toEqual([]);
    expect(zones[0].footprint).toEqual(desiredFootprint);
    const bedRight = zones[0].position.x + zones[0].footprint.width / 2;
    const storageLeft = room.objects[0].position.x - room.objects[0].dimensions.width / 2;
    expect(storageLeft - bedRight).toBeGreaterThanOrEqual(0.6);
    expect(storageLeft - bedRight).toBeLessThanOrEqual(0.61);
  });

  it("falls back through real bed sizes and keeps the search query consistent", () => {
    const room = {
      ...sampleRoom,
      dimensions: { width: 2.8, height: 2.7, depth: 2.9 },
      openings: [],
      objects: [],
    };
    const { zones, rejected } = reserveZones(room, buildSpaceModel(room), [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "upholstered queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: { width: 1.65, depth: 2.15 },
        desiredHeight: null,
      },
    ]);
    expect(rejected).toEqual([]);
    expect(zones[0].footprint).toEqual({ width: 1.5, depth: 2.05 });
    expect(zones[0].query).toContain("full bed");
    expect(zones[0].query).not.toContain("queen");
    expect(zones[0].miscellaneous).toContain(
      "full size, about 1.50 × 2.05 m",
    );
    // A frame larger than the mattress must survive the search/fit handoff.
    const product = {
      ...sampleProducts[0],
      measurement: {
        ...sampleProducts[0].measurement,
        dimensions: { width: 1.46, depth: 2.01, height: 1 },
      },
    };
    expect(evaluateFill(zones[0], product).fits).toBe("yes");
    expect(evaluateFill(zones[0], {
      ...product,
      measurement: { ...product.measurement,
        dimensions: { width: 1.6, depth: 2.2, height: 1 },
      },
    }).fits).toBe("no");
  });

  it("retries with minimal clearances when a small room cannot spare full walkways", () => {
    // A 2.2 m room leaves < 0.6 m between a bed and the dresser, so every
    // candidate fails at standard margins even though the frame itself fits.
    const room = {
      ...sampleRoom,
      dimensions: { width: 2.2, height: 2.7, depth: 3 },
      openings: [],
      objects: [
        {
          id: "owned-dresser",
          name: "Your dresser",
          category: "storage",
          productId: null,
          assetId: null,
          dimensions: { width: 0.5, height: 0.9, depth: 1.2 },
          position: { x: 1.95, y: 0, z: 1.5 },
          rotation: { x: 0, y: 0, z: 0 },
          color: "#997659",
          owned: true,
          locked: true,
        },
      ],
    };
    const { zones, rejected } = reserveZones(room, buildSpaceModel(room), [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: { width: 1.65, depth: 2.15 },
        desiredHeight: null,
      },
    ]);
    expect(rejected).toEqual([]);
    const zone = zones[0];
    expect(zone.margins.sides).toBeLessThan(0.6);
    expect(zone.clearanceRules).toContain(
      `Keep ${zone.margins.sides} m on each side.`,
    );
    expect(
      designPlacementIssue(room, {
        ...sampleRoom.objects[0],
        owned: false,
        position: zone.position,
        rotation: { x: 0, y: zone.rotationY, z: 0 },
        dimensions: { ...zone.footprint, height: 1 },
      }),
    ).toBeNull();
  });
});

describe("accessories", () => {
  const model = buildSpaceModel(sampleRoom);

  it("hangs a painting on a wall span clear of the window and door", () => {
    const { zones, rejected } = reserveZones(sampleRoom, model, [
      {
        ...lampZone,
        id: "art",
        category: "wall art",
        query: "abstract canvas print",
        relatedObjectId: null,
        desiredFootprint: { width: 1.0, depth: 0.05 },
        desiredHeight: 0.7,
      },
    ]);
    expect(rejected).toEqual([]);
    const art = zones[0];
    expect(art.mount).toBe("wall");
    expect(art.position.y).toBe(1.2);
    expect(art.maxHeight).toBeLessThan(sampleRoom.dimensions.height - 1.2);
    // On the north wall the window spans x 2.7–4.1; the art must not overlap it.
    if (art.position.z < 0.2) {
      const from = art.position.x - art.footprint.width / 2;
      const to = art.position.x + art.footprint.width / 2;
      expect(to <= 2.7 || from >= 4.1).toBe(true);
    }
    expect(art.miscellaneous).toContain("wall mounted");
  });

  it("sets a desk lamp on the owned desk at its top height", () => {
    const { zones, rejected } = reserveZones(sampleRoom, model, [
      {
        ...lampZone,
        id: "desk-lamp",
        category: "desk lamp",
        query: "brass desk lamp",
        relatedObjectId: "owned-desk",
        desiredFootprint: { width: 0.2, depth: 0.2 },
        desiredHeight: 0.5,
      },
    ]);
    expect(rejected).toEqual([]);
    const lamp = zones[0];
    expect(lamp.mount).toBe("surface");
    expect(lamp.position.y).toBeCloseTo(0.75, 5);
    // Inside the desk top: x 3.1–4.3, z 0.25–0.85.
    expect(lamp.position.x).toBeGreaterThan(3.1);
    expect(lamp.position.x).toBeLessThan(4.3);
    expect(lamp.position.z).toBeGreaterThan(0.25);
    expect(lamp.position.z).toBeLessThan(0.85);
    expect(lamp.maxHeight).toBeCloseTo(2.7 - 0.75 - 0.1, 5);
  });

  it("puts a lamp on a nightstand planned in the same request, host first", () => {
    const { zones, rejected } = reserveZones(sampleRoom, model, [
      {
        ...lampZone,
        id: "lamp",
        category: "table lamp",
        query: "ceramic table lamp",
        mount: "surface",
        relatedObjectId: "nightstand",
        desiredFootprint: { width: 0.25, depth: 0.25 },
        priority: 1,
      },
      {
        ...lampZone,
        id: "nightstand",
        category: "nightstand",
        query: "oak nightstand",
        anchor: "near-object",
        relatedObjectId: "owned-bed",
        desiredFootprint: { width: 0.45, depth: 0.4 },
        desiredHeight: 0.55,
        priority: 2,
      },
    ]);
    expect(rejected).toEqual([]);
    expect(zones.map((zone) => zone.id)).toEqual(["nightstand", "lamp"]);
    const [stand, lamp] = zones;
    expect(lamp.position.x).toBeCloseTo(stand.position.x, 0);
    expect(lamp.footprint.width).toBeLessThanOrEqual(stand.footprint.width);
    expect(lamp.clearanceRules[0]).toContain("follows the chosen host product");
  });

  it("lets two pieces share a walkway: clearances may overlap, bodies may not", () => {
    const room = { ...sampleRoom, objects: [] };
    const empty = buildSpaceModel(room);
    const piece = (id: string, category: string, width: number, depth: number, priority: number) => ({
      ...lampZone, id, category, query: category, anchor: "wall" as const,
      relatedObjectId: null, desiredFootprint: { width, depth }, desiredHeight: null, priority,
    });
    // A bed (0.6 m side clearance) and a wardrobe (0.75 m front clearance) in
    // a 4.8 × 4.2 m room: their clearances meet in the middle as one walkway.
    const { zones, rejected } = reserveZones(room, empty, [
      piece("bed", "bed", 1.6, 2.0, 1),
      piece("wardrobe", "wardrobe", 1.8, 0.6, 2),
      piece("desk", "desk", 1.2, 0.6, 3),
      piece("chair", "armchair", 0.8, 0.8, 4),
    ]);
    expect(rejected).toEqual([]);
    expect(zones).toHaveLength(4);
    // No two bodies overlap.
    const bodies = zones.map((zone) =>
      rectangleRing({ x: zone.position.x, z: zone.position.z }, zone.footprint.width, zone.footprint.depth, zone.rotationY),
    );
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++)
        expect(ringsOverlap(bodies[i], bodies[j])).toBe(false);
  });

  it("lets a nightstand stand in a planned bed's side clearance, then hosts a lamp", () => {
    const room = { ...sampleRoom, objects: [] };
    const empty = buildSpaceModel(room);
    const { zones, rejected } = reserveZones(room, empty, [
      {
        ...lampZone,
        id: "bed",
        category: "bed",
        query: "queen bed",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: { width: 1.6, depth: 2.0 },
        desiredHeight: null,
        priority: 1,
      },
      {
        ...lampZone,
        id: "stand",
        category: "nightstand",
        query: "nightstand",
        anchor: "near-object",
        relatedObjectId: "bed",
        desiredFootprint: { width: 0.45, depth: 0.4 },
        desiredHeight: 0.55,
        priority: 2,
      },
      {
        ...lampZone,
        id: "lamp",
        category: "table lamp",
        query: "table lamp",
        mount: "surface",
        relatedObjectId: "stand",
        desiredFootprint: { width: 0.25, depth: 0.25 },
        priority: 3,
      },
    ]);
    expect(rejected).toEqual([]);
    const bed = zones.find((zone) => zone.id === "bed")!;
    const stand = zones.find((zone) => zone.id === "stand")!;
    // The nightstand sits right beside the bed, inside the 0.6 m side margin.
    const gap =
      Math.abs(stand.position.x - bed.position.x) -
      bed.footprint.width / 2 -
      stand.footprint.width / 2;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(0.6);
    expect(zones.find((zone) => zone.id === "lamp")!.relatedObjectId).toBe("stand");
  });

  it("refuses to put things on a bed and requires a host for surface pieces", () => {
    const { rejected } = reserveZones(sampleRoom, model, [
      {
        ...lampZone,
        id: "on-bed",
        category: "table lamp",
        query: "lamp",
        mount: "surface",
        relatedObjectId: "owned-bed",
        desiredFootprint: { width: 0.2, depth: 0.2 },
      },
      {
        ...lampZone,
        id: "no-host",
        category: "vase",
        query: "vase",
        mount: "surface",
        relatedObjectId: null,
        desiredFootprint: { width: 0.1, depth: 0.1 },
        priority: 2,
      },
    ]);
    expect(rejected.map((item) => item.zoneId).sort()).toEqual(["no-host", "on-bed"]);
    expect(rejected.find((item) => item.zoneId === "on-bed")?.reason).toContain("no top");
  });

  it("infers the mount from the category when the model leaves it on the floor", () => {
    const { zones } = buildDesignPlan({
      room: sampleRoom,
      brief: sampleBrief,
      products: sampleProducts,
      request: {
        summary: "Accessories only.",
        spacing: "balanced",
        zones: [
          { ...lampZone, id: "mirror", category: "wall mirror", query: "round mirror", relatedObjectId: null, desiredFootprint: { width: 0.6, depth: 0.05 } },
          { ...lampZone, id: "runner", category: "runner rug", query: "runner rug", relatedObjectId: null, desiredFootprint: { width: 0.7, depth: 2 }, priority: 2 },
        ],
      },
    }).plan;
    expect(zones.map((zone) => [zone.id, zone.mount])).toEqual([
      ["runner", "under"],
      ["mirror", "wall"],
    ]);
  });

  it("lets a wall piece be searched as width × height, not width × thickness", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: sampleBrief,
      products: sampleProducts,
      request: {
        summary: "One painting.",
        spacing: "balanced",
        zones: [
          { ...lampZone, id: "art", category: "wall art", query: "canvas", mount: "wall", relatedObjectId: null, desiredFootprint: { width: 1.0, depth: 0.04 }, desiredHeight: 0.7 },
        ],
      },
    });
    const task = plan.tasks[0];
    expect(task.maxFootprint?.width).toBe(1);
    expect(task.maxFootprint?.depth).toBe(plan.zones[0].maxHeight ?? -1);
    expect(task.maxFootprint!.depth).toBeGreaterThan(0.5);
  });
});

describe("design plan", () => {
  it("plans a bedroom without a bed when the user excludes it, even after a failed bed request", () => {
    const room = { ...sampleRoom, objects: [], openings: [] };
    const chair = { ...lampZone, id: "chair", category: "armchair", query: "modern armchair",
      relatedObjectId: null, anchor: "wall" as const,
      desiredFootprint: { width: 0.7, depth: 0.7 },
    };
    for (const exclusions of [
      { excludedCategories: ["bed"], restrictions: [] },
      { restrictions: ["No bed"] },
      { restrictions: ["I do not need the bed."] },
    ]) {
      const brief = { ...sampleBrief, wants: [], purpose: "bedroom", ...exclusions };
      const { plan } = buildDesignPlan({ room, brief, products: [],
        request: { ...request, zones: [chair] },
      });
      expect(plan.zones.map((zone) => zone.category)).toEqual(["armchair"]);
      expect(plan.tasks.map((task) => task.category)).toEqual(["armchair"]);
      expect(describeScope(planScope(brief), brief.purpose)).toContain("excluded furniture");
      for (const category of ["bed", "daybed", "queen bed"]) {
        expect(() => buildDesignPlan({ room, brief, products: [],
          request: { ...request, zones: [{ ...chair, category }] },
        })).toThrow("user excluded");
      }
    }
  });

  it("keeps exclusions above stale wants, but does not mistake bed size limits for an exclusion", () => {
    const scope = planScope({ ...sampleBrief, purpose: "bedroom",
      wants: [{ category: "bed", notes: "" }, { category: "dresser", notes: "" }],
      excludedCategories: ["bed"],
    });
    expect(scope.required).toEqual(["dresser"]);
    for (const restriction of ["No bed wider than 2 m", "No bed bugs", "No drilling"])
      expect(planScope({ ...sampleBrief, purpose: "bedroom", restrictions: [restriction] }).excluded).toEqual([]);
  });

  it("does not force a bedroom anchor into a specific shopping list", () => {
    const room = { ...sampleRoom, objects: [], openings: [] };
    const chair = { ...lampZone, id: "chair", category: "armchair", query: "armchair",
      relatedObjectId: null, anchor: "wall" as const,
      desiredFootprint: { width: 0.7, depth: 0.7 },
    };
    const brief = { ...sampleBrief, purpose: "bedroom", wants: [{ category: "armchair", notes: "" }] };
    expect(buildDesignPlan({ room, brief, products: [], request: { ...request, zones: [chair] } })
      .plan.zones.map((zone) => zone.category)).toEqual(["armchair"]);
    // Opting back into delegated furnishing with no exclusion retains the
    // missing-bed guard; this fix must not reintroduce silent omissions.
    expect(() => buildDesignPlan({ room, brief: { ...brief, wants: [], excludedCategories: [] },
      products: [], request: { ...request, zones: [chair] },
    })).toThrow("missing its defining bed");
  });

  it("plans requested paintings despite an owned mirror classified as art", () => {
    const room = {
      ...sampleRoom,
      objects: [...sampleRoom.objects, {
        ...sampleRoom.objects[0], id: "vanity-mirror", name: "Vanity mirror",
        category: "art" as const, dimensions: { width: 0.4, height: 0.6, depth: 0.03 },
        position: { x: 4, y: 1.3, z: 4.16 },
      }],
    };
    for (const category of ["art", "painting", "classic posters", "framed prints"]) {
      const { plan } = buildDesignPlan({
        room, brief: { ...sampleBrief, wants: [{ category: "art", notes: "16th century paintings" }] },
        products: sampleProducts,
        request: { ...request, zones: [{
          ...lampZone, id: "art", category, query: "Renaissance painting poster",
          mount: "floor", relatedObjectId: null,
          desiredFootprint: { width: 0.5, depth: 0.03 }, desiredHeight: 0.7,
        }] },
      });
      expect(plan.rejected).toEqual([]);
      expect(plan.zones[0].mount).toBe("wall");
      expect(plan.zones[0].suggested).toBe(false);
      expect(plan.tasks[0].miscellaneous).toContain("16th century paintings");
      const product = {
        ...sampleProducts[0], category,
        measurement: { ...sampleProducts[0].measurement, dimensions: { width: 0.5, height: 0.7, depth: 0.03 } },
      };
      const placed = objectInZone(room, product, "new-art", plan.zones[0]);
      expect(placed.category).toBe("art");
      expect(designPlacementIssue(room, placed)).toBeNull();
    }
    expect(sameCategory("art", "cart")).toBe(false);
    expect(sameCategory("art", "vanity mirror")).toBe(false);
    expect(sameCategory("", "art")).toBe(false);
  });

  it("rejects duplicate categories and categories the room already has", () => {
    expect(() =>
      buildDesignPlan({
        room: sampleRoom,
        brief: sampleBrief,
        products: sampleProducts,
        request: { ...request, zones: [lampZone, { ...lampZone, id: "two" }] },
      }),
    ).toThrow("one zone per category");
    expect(() =>
      buildDesignPlan({
        room: sampleRoom,
        brief: sampleBrief,
        products: sampleProducts,
        request: {
          ...request,
          zones: [{ ...lampZone, category: "bed", query: "bed" }],
        },
      }),
    ).toThrow("already has a bed");
  });

  it("derives one search task per reserved zone with room-aware ceilings", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: sampleBrief,
      products: sampleProducts,
      request,
    });
    expect(plan.roomId).toBe(sampleRoom.id);
    expect(plan.baseRevision).toBe(sampleRoom.revision);
    expect(plan.tasks).toHaveLength(plan.zones.length);
    for (const [index, task] of plan.tasks.entries()) {
      expect(searchTaskSchema.safeParse(task).success).toBe(true);
      expect(task.maxFootprint).toEqual(plan.zones[index].footprint);
      expect(plan.zones[index].mount).not.toBe("wall");
      expect(task.styleTerms).toEqual(sampleBrief.styles);
      expect(task.excludeTags).toContain("wall-mounted");
    }
    const total = plan.tasks.reduce((sum, task) => sum + task.maxPriceCents, 0);
    expect(total).toBeLessThanOrEqual(sampleBrief.budgetCents);
    expect(total).toBeGreaterThan(0);
  });

  it("gives every zone a zero ceiling when no budget was specified", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: { ...sampleBrief, budgetCents: 0 },
      products: sampleProducts,
      request,
    });
    expect(plan.tasks.every((task) => task.maxPriceCents === 0)).toBe(true);
  });

  it("stops planning purchases when existing selections exhaust the budget", () => {
    const product = sampleProducts[0];
    const room = {
      ...sampleRoom,
      objects: sampleRoom.objects.map((object, index) => index === 1
        ? { ...object, owned: false, productId: product.id }
        : object),
    };
    for (const budgetCents of [product.priceCents, product.priceCents - 1]) {
      expect(() => buildDesignPlan({
        room, brief: { ...sampleBrief, budgetCents }, products: [product], request,
      })).toThrow("budget");
    }
    const { plan } = buildDesignPlan({
      room, brief: { ...sampleBrief, budgetCents: product.priceCents + 1000 },
      products: [product], request,
    });
    expect(plan.tasks.every((task) => task.maxPriceCents > 0)).toBe(true);
    expect(plan.tasks.reduce((sum, task) => sum + task.maxPriceCents, 0)).toBeLessThanOrEqual(1000);
    expect(() => buildDesignPlan({
      room, brief: sampleBrief, products: [], request,
    })).toThrow("Missing price");
  });

  it("never rounds a finite per-item budget into an unlimited search", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom, brief: sampleBrief, products: sampleProducts, request,
    });
    const allocation = allocateBudget(plan.zones, plan.zones.length);
    expect([...allocation.values()]).toEqual(plan.zones.map(() => 1));
    expect(() => allocateBudget(plan.zones, plan.zones.length - 1)).toThrow("budget");
  });

  it("weights budget toward higher-priority zones", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: sampleBrief,
      products: sampleProducts,
      request,
    });
    const allocation = allocateBudget(plan.zones, 30000);
    expect(allocation.get("reading-light")!).toBeGreaterThan(
      allocation.get("rug")!,
    );
  });

  it("maps restrictions to exclusion tags", () => {
    expect(excludeTagsFor(sampleBrief)).toContain("wall-mounted");
    expect(excludeTagsFor({ ...sampleBrief, restrictions: [] })).toEqual([]);
  });

  it("requires a zone for every want and marks extras as suggestions", () => {
    const brief = {
      ...sampleBrief,
      wants: [
        { category: "floor lamp", notes: "warm dimmable light" },
        { category: "rug", notes: "" },
      ],
      palette: ["sage", "black"],
      materials: ["oak"],
    };
    expect(() =>
      buildDesignPlan({
        room: sampleRoom,
        brief,
        products: sampleProducts,
        request: { ...request, zones: [lampZone] },
      }),
    ).toThrow("leaves out items the user asked for: rug");
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief,
      products: sampleProducts,
      request: {
        ...request,
        zones: [
          ...request.zones,
          { ...lampZone, id: "art", category: "wall art", query: "print", relatedObjectId: null, desiredFootprint: { width: 0.8, depth: 0.05 }, priority: 3 },
        ],
      },
    });
    expect(plan.zones.map((zone) => [zone.category, zone.suggested])).toEqual([
      ["floor lamp", false],
      ["rug", false],
      ["wall art", true],
    ]);
    const lamp = plan.tasks[0];
    // Color words reach search as hex for ranking and as words for the query.
    expect(lamp.palette).toEqual(["#9caa8c", "#1a1a1a"]);
    expect(lamp.miscellaneous).toContain("sage");
    expect(lamp.miscellaneous).toContain("warm dimmable light");
    expect(lamp.miscellaneous).toContain("oak");
    expect(plan.tasks[1].miscellaneous).not.toContain("warm dimmable light");
  });

  it("allows one extra floor piece beyond the wants, accessories aside", () => {
    const brief = { ...sampleBrief, wants: [{ category: "floor lamp", notes: "" }] };
    const extra = (id: string, category: string, mount: "floor" | "wall" = "floor") => ({
      ...lampZone, id, category, query: category, mount, relatedObjectId: null,
      desiredFootprint: { width: 0.5, depth: mount === "wall" ? 0.05 : 0.5 }, priority: 2,
    });
    expect(() =>
      buildDesignPlan({
        room: sampleRoom,
        brief,
        products: sampleProducts,
        request: { ...request, zones: [lampZone, extra("a", "armchair"), extra("b", "side table")] },
      }),
    ).toThrow("Only 1 extra floor piece");
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief,
      products: sampleProducts,
      request: { ...request, zones: [lampZone, extra("a", "armchair"), extra("b", "wall art", "wall"), extra("c", "mirror", "wall")] },
    });
    expect(plan.zones.filter((zone) => zone.suggested)).toHaveLength(3);
  });

  it("delegates item choice when no wants are given and refuses accessories on request", () => {
    const delegated = { ...sampleBrief, wants: [], purpose: "bedroom" };
    expect(planScope(delegated).mode).toBe("delegated");
    expect(describeScope(planScope(delegated), "bedroom")).toContain("has not listed items");
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: delegated,
      products: sampleProducts,
      request,
    });
    // Delegated pieces are the plan, not suggestions.
    expect(plan.zones.every((zone) => !zone.suggested)).toBe(true);
    expect(() =>
      buildDesignPlan({
        room: sampleRoom,
        brief: { ...delegated, accessories: "skip" },
        products: sampleProducts,
        request,
      }),
    ).toThrow("does not want accessories; drop rug");
  });

  it("requires a missing room-defining piece and reuses its removed placement", () => {
    const removedBed = sampleRoom.objects[0];
    const room = {
      ...sampleRoom,
      objects: sampleRoom.objects.filter((object) => object.id !== removedBed.id),
    };
    const brief = { ...sampleBrief, wants: [], purpose: "bedroom" };
    const bed = {
      ...lampZone,
      id: "replacement-bed",
      purpose: "restore the room's primary sleeping function",
      category: "bed",
      query: "queen bed",
      anchor: "wall" as const,
      relatedObjectId: null,
      desiredFootprint: { width: 1.65, depth: 2.15 },
      desiredHeight: null,
    };
    expect(() =>
      buildDesignPlan({
        room,
        brief,
        products: sampleProducts,
        request: {
          ...request,
          zones: [{ ...lampZone, id: "bench", category: "bedroom bench" }],
        },
      }),
    ).toThrow("missing its defining bed");

    const { plan } = buildDesignPlan({
      room,
      brief,
      products: sampleProducts,
      request: { ...request, zones: [bed] },
      placementHints: [removedBed],
    });
    expect(plan.zones[0].category).toBe("bed");
    expect(plan.zones[0].position).toEqual(removedBed.position);
  });

  it("does not return accent furniture when the defining piece cannot fit", () => {
    const room = {
      ...sampleRoom,
      name: "Tiny bedroom",
      dimensions: { width: 1, height: 2.4, depth: 1 },
      objects: [],
      openings: [],
    };
    const brief = { ...sampleBrief, wants: [], purpose: "bedroom" };
    expect(() =>
      buildDesignPlan({
        room,
        brief,
        products: sampleProducts,
        request: {
          summary: "A bed and an accent chair.",
          spacing: "balanced",
          zones: [
            {
              ...lampZone,
              id: "bed",
              category: "bed",
              query: "queen bed",
              anchor: "wall",
              relatedObjectId: null,
              desiredFootprint: { width: 1.6, depth: 2.0 },
              desiredHeight: null,
              priority: 1,
            },
            {
              ...lampZone,
              id: "chair",
              category: "armchair",
              query: "bedroom armchair",
              relatedObjectId: null,
              priority: 2,
            },
          ],
        },
      }),
    ).toThrow("defining bed could not be reserved");
  });

  it("scales clearance with spacing but never below the safety minimums", () => {
    const bed = marginsFor("bed");
    expect(scaleMargins(bed, "airy").front).toBeCloseTo(0.94, 2);
    expect(scaleMargins(bed, "cozy").sides).toBeCloseTo(0.51, 2);
    // A lamp's 0.3 m front clearance is already under the walking minimum, so
    // cozy keeps it at 0.3 rather than shrinking or inflating it.
    expect(scaleMargins(marginsFor("floor lamp"), "cozy").front).toBe(0.3);
    expect(scaleMargins(marginsFor("floor lamp"), "balanced")).toEqual(marginsFor("floor lamp"));
    // A sofa's 0.75 m front may shrink only to the 0.6 m walking minimum.
    expect(scaleMargins(marginsFor("sofa"), "cozy").front).toBe(0.64);
    expect(scaleMargins(marginsFor("rug"), "airy")).toEqual({ front: 0, back: 0, sides: 0 });
    const model = buildSpaceModel({ ...sampleRoom, objects: [] });
    const zone = (id: string) => ({
      ...lampZone, id, category: "bed", query: "bed", anchor: "wall" as const,
      relatedObjectId: null, desiredFootprint: { width: 1.6, depth: 2 }, desiredHeight: null,
    });
    const airy = reserveZones({ ...sampleRoom, objects: [] }, model, [zone("bed")], "airy");
    const cozy = reserveZones({ ...sampleRoom, objects: [] }, model, [zone("bed")], "cozy");
    expect(airy.zones[0].margins.sides).toBeGreaterThan(cozy.zones[0].margins.sides);
    expect(SPACING_FACTOR.airy).toBeGreaterThan(SPACING_FACTOR.cozy);
  });

  it("reports whether a found product fits its zone", () => {
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: sampleBrief,
      products: sampleProducts,
      request,
    });
    const lamp = plan.zones[0];
    expect(evaluateFill(lamp, sampleProducts[0]).fits).toBe("yes");
    expect(
      evaluateFill(lamp, {
        ...sampleProducts[2],
        measurement: {
          dimensions: { width: 3, height: 0.7, depth: 0.4 },
          source: "estimated",
          evidence: { kind: "spec-text", detail: "spec" },
        },
      }).fits,
    ).toBe("no");
    expect(
      evaluateFill(lamp, {
        ...sampleProducts[0],
        measurement: {
          dimensions: null,
          source: "unknown",
          evidence: { kind: "none", detail: null },
        },
      }).fits,
    ).toBe("unknown");
    expect(evaluateFill(lamp, null).fits).toBe("no");
  });
});
