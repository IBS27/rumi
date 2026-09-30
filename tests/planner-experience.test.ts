import { describe, expect, it } from "bun:test";
import { Matrix4 } from "three";
import type {
  ProductCandidate,
  RoomSnapshot,
  ZoneRequest,
} from "../shared/contracts";
import { importRoomPlan } from "../shared/capture/roomplan";
import {
  applyDesignCommands,
  designPlacementIssue,
  productObject,
} from "../shared/design";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import {
  buildDesignPlan,
  buildSpaceModel,
  findFreeFloorAreas,
} from "../shared/planner";
import {
  rectangleRing,
  ringInside,
  ringsOverlap,
} from "../shared/planner/space";

const room: RoomSnapshot = {
  ...sampleRoom,
  objects: [],
  openings: [],
  dimensions: { width: 6, depth: 5, height: 2.7 },
};
const brief = { ...sampleBrief, wants: [], purpose: "bedroom", budgetCents: 0 };
const piece = (
  id: string,
  category: string,
  priority: number,
  extra: Partial<ZoneRequest> = {},
): ZoneRequest => ({
  id,
  category,
  query: category,
  purpose: `Add ${category}`,
  priority,
  mount: "floor",
  anchor: "wall",
  relatedObjectId: null,
  desiredFootprint: { width: 0.5, depth: 0.5 },
  desiredHeight: null,
  miscellaneous: [],
  ...extra,
});
const bed = piece("bed", "queen bed", 1, {
  desiredFootprint: { width: 1.65, depth: 2.15 },
});
const desk = piece("desk", "desk", 2, {
  desiredFootprint: { width: 1.2, depth: 0.6 },
  desiredHeight: 0.75,
});
const chair = piece("chair", "accent chair", 3, {
  desiredFootprint: { width: 0.7, depth: 0.7 },
});
const lamp = piece("lamp", "floor lamp", 4);
const stand = piece("stand", "nightstand", 5);
const rug = piece("rug", "area rug", 6, {
  mount: "under",
  anchor: "center",
  desiredFootprint: { width: 2.4, depth: 1.7 },
});
const request = (zones: ZoneRequest[]) => ({
  summary: "Furnish the bedroom.",
  spacing: "balanced",
  zones,
});

describe("measured free-floor context", () => {
  it("leaves a large area available to multiple pieces and produces a placeable plan", () => {
    expect(findFreeFloorAreas(buildSpaceModel(room))).toHaveLength(1);
    const { plan } = buildDesignPlan({
      room,
      brief,
      products: [],
      request: request([bed, desk, chair, lamp, rug]),
    });
    expect(plan.zones.map((zone) => zone.id)).toEqual([
      "bed",
      "desk",
      "chair",
      "lamp",
      "rug",
    ]);
    expect(plan.rejected).toEqual([]);
    // Follow the actual product-to-command path, including canonical dimensions.
    const products: ProductCandidate[] = plan.zones.map((zone) => ({
      ...sampleProducts[0],
      id: zone.id,
      name: zone.category,
      category: zone.category,
      availability: "available",
      priceCents: 10000,
      measurement: {
        ...sampleProducts[0].measurement,
        source: "confirmed",
        dimensions: {
          ...zone.footprint,
          height: zone.mount === "under" ? 0.012 : 0.75,
        },
      },
    }));
    const placed = applyDesignCommands(
      room,
      plan.zones.map((zone) => ({
        type: "add" as const,
        productId: zone.id,
        instanceId: zone.id,
        zone,
      })),
      products,
      brief,
      "agent",
    );
    expect(placed.objects).toHaveLength(5);
    for (const object of placed.objects)
      expect(designPlacementIssue(placed, object)).toBeNull();
    expect(
      placed.objects.find((object) => object.id === "rug")?.dimensions.height,
    ).toBe(0.012);
  });

  it("keeps measured areas inside angled floors and clear of objects and doors", () => {
    for (const yaw of [0, 0.63, -0.8]) {
      const scan = importRoomPlan(syntheticRoomPlan);
      const rotation = new Matrix4().makeRotationY(yaw);
      for (const surface of [...scan.walls, ...scan.floors, ...scan.openings])
        surface.transform = rotation
          .clone()
          .multiply(new Matrix4().fromArray(surface.transform))
          .toArray();
      scan.objects = [];
      const model = buildSpaceModel(scan);
      const areas = findFreeFloorAreas(model);
      expect(areas.length).toBeGreaterThan(0);
      for (const area of areas) {
        const ring = rectangleRing(
          area.center,
          area.width,
          area.depth,
          area.rotationY,
        );
        expect(ringInside(ring, model.floor)).toBe(true);
        for (const door of model.clearances)
          expect(ringsOverlap(ring, door.footprint)).toBe(false);
      }
    }
    const model = buildSpaceModel(sampleRoom);
    for (const area of findFreeFloorAreas(model)) {
      const ring = rectangleRing(
        area.center,
        area.width,
        area.depth,
        area.rotationY,
      );
      for (const obstacle of model.obstacles)
        expect(ringsOverlap(ring, obstacle.footprint)).toBe(false);
    }
  });

  it("does not treat rugs or high wall decor as occupied floor", () => {
    const model = buildSpaceModel(room);
    const areas = findFreeFloorAreas(model);
    model.obstacles = [
      {
        id: "rug",
        name: "Rug",
        category: "rug",
        bottom: 0,
        top: 0.02,
        locked: false,
        footprint: rectangleRing({ x: 3, z: 2.5 }, 4, 3),
      },
      {
        id: "mirror",
        name: "Mirror",
        category: "art",
        bottom: 1.2,
        top: 2,
        locked: false,
        footprint: rectangleRing({ x: 3, z: 0.5 }, 2, 0.1),
      },
    ];
    expect(findFreeFloorAreas(model)).toEqual(areas);
  });

  it("never calls a rectangle free when raster sampling misses a thin obstacle", () => {
    const model = buildSpaceModel(room);
    model.obstacles = [
      {
        id: "post",
        name: "Thin post",
        category: "storage",
        bottom: 0,
        top: 2,
        locked: true,
        footprint: rectangleRing({ x: 3.013, z: 2.013 }, 0.01, 0.01),
      },
    ];
    for (const area of findFreeFloorAreas(model)) {
      expect(
        ringsOverlap(
          rectangleRing(area.center, area.width, area.depth, area.rotationY),
          model.obstacles[0].footprint,
        ),
      ).toBe(false);
    }
  });
});

describe("focused initial plans", () => {
  it("keeps the essential bed and four non-rug pieces, with a named reason for extras", () => {
    const { plan } = buildDesignPlan({
      room,
      brief,
      products: [],
      request: request([bed, desk, chair, lamp, stand, rug]),
    });
    expect(plan.zones.map((zone) => zone.id)).toEqual([
      "bed",
      "desk",
      "chair",
      "lamp",
      "rug",
    ]);
    expect(plan.rejected).toContainEqual({
      zoneId: "stand",
      reason:
        "Left out nightstand to keep the initial plan to 4 pieces, plus rugs. You can ask to add it later.",
    });
    expect(plan.tasks.map((task) => task.category)).not.toContain("nightstand");
  });

  it("keeps all five explicitly requested furniture pieces", () => {
    const zones = [bed, desk, chair, lamp, stand];
    const { plan } = buildDesignPlan({
      room,
      brief: {
        ...brief,
        wants: zones.map((zone) => ({ category: zone.category, notes: "" })),
      },
      products: [],
      request: request(zones),
    });
    expect(plan.zones).toHaveLength(5);
    expect(plan.zones.every((zone) => !zone.suggested)).toBe(true);
    expect(plan.rejected).toEqual([]);
  });

  it("accepts the full twelve-item shopping list allowed by the brief", () => {
    const categories = [
      "bed",
      "desk",
      "chair",
      "floor lamp",
      "nightstand",
      "wardrobe",
      "dresser",
      "bookcase",
      "bench",
      "sofa",
      "console",
      "plant",
    ];
    const zones = categories.map((category, index) =>
      piece(category, category, index + 1),
    );
    const { plan } = buildDesignPlan({
      room: { ...room, dimensions: { width: 12, depth: 12, height: 2.7 } },
      brief: {
        ...brief,
        wants: categories.map((category) => ({ category, notes: "" })),
      },
      products: [],
      request: request(zones),
    });
    expect(plan.zones).toHaveLength(12);
    expect(plan.tasks).toHaveLength(12);
    expect(plan.rejected).toEqual([]);
  });

  it("does not count a piece that cannot fit toward the cap", () => {
    const impossible = piece("wardrobe", "wardrobe", 2, {
      desiredFootprint: { width: 20, depth: 20 },
    });
    const { plan } = buildDesignPlan({
      room,
      brief,
      products: [],
      request: request([bed, impossible, desk, chair, lamp]),
    });
    expect(plan.zones).toHaveLength(4);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].zoneId).toBe("wardrobe");
  });

  it("uses the requested priority across floor furniture and wall accessories", () => {
    const art = piece("art", "wall art", 2, {
      mount: "wall",
      desiredFootprint: { width: 0.6, depth: 0.04 },
      desiredHeight: 0.6,
    });
    const { plan } = buildDesignPlan({
      room,
      brief,
      products: [],
      request: request([
        bed,
        art,
        { ...desk, priority: 3 },
        { ...chair, priority: 4 },
        { ...lamp, priority: 5 },
      ]),
    });
    expect(plan.zones.map((zone) => zone.id).sort()).toEqual([
      "art",
      "bed",
      "chair",
      "desk",
    ]);
    expect(plan.rejected[0].zoneId).toBe("lamp");
  });

  it("protects supporting furniture for a requested accessory, including against budget trimming", () => {
    const tableLamp = piece("table-lamp", "table lamp", 5, {
      mount: "surface",
      relatedObjectId: "desk",
      desiredFootprint: { width: 0.15, depth: 0.15 },
      desiredHeight: 0.25,
    });
    const zones = [bed, chair, lamp, tableLamp, { ...desk, priority: 8 }];
    const wants = zones
      .filter((zone) => zone.id !== "desk")
      .map((zone) => ({ category: zone.category, notes: "" }));
    const { plan } = buildDesignPlan({
      room,
      brief: { ...brief, wants },
      products: [],
      request: request(zones),
    });
    expect(plan.zones).toHaveLength(5);
    expect(plan.zones.find((zone) => zone.id === "desk")?.suggested).toBe(
      false,
    );
    expect(
      plan.zones.find((zone) => zone.id === "table-lamp")?.relatedObjectId,
    ).toBe("desk");
    const products: ProductCandidate[] = plan.zones.map((zone) => ({
      ...sampleProducts[0],
      id: zone.id,
      name: zone.category,
      category: zone.category,
      availability: "available",
      measurement: {
        ...sampleProducts[0].measurement,
        source: "confirmed",
        dimensions: {
          ...zone.footprint,
          height: zone.mount === "surface" ? 0.25 : 0.75,
        },
      },
    }));
    const placed = applyDesignCommands(
      room,
      plan.zones.map((zone) => ({
        type: "add" as const,
        productId: zone.id,
        instanceId: zone.id,
        zone,
      })),
      products,
      { ...brief, wants },
      "agent",
    );
    const placedLamp = placed.objects.find(
      (object) => object.id === "table-lamp",
    )!;
    expect(placedLamp.supportId).toBe("desk");
    expect(designPlacementIssue(placed, placedLamp)).toBeNull();
    expect(() =>
      buildDesignPlan({
        room,
        brief: { ...brief, wants, budgetCents: 10000 },
        products: [],
        request: request(zones),
      }),
    ).toThrow("cannot cover the requested items");
  });

  it("honors exclusions and accessories-only requests without inserting floor furniture", () => {
    const art = piece("art", "wall art", 1, {
      mount: "wall",
      desiredFootprint: { width: 0.6, depth: 0.04 },
      desiredHeight: 0.6,
    });
    const { plan } = buildDesignPlan({
      room,
      brief: {
        ...brief,
        excludedCategories: ["bed"],
        wants: [{ category: "wall art", notes: "" }],
      },
      products: [],
      request: request([art, rug]),
    });
    expect(plan.zones.map((zone) => zone.mount).sort()).toEqual([
      "under",
      "wall",
    ]);
    const product = {
      ...sampleProducts[0],
      category: "area rug",
      availability: "available" as const,
      measurement: {
        ...sampleProducts[0].measurement,
        source: "confirmed" as const,
        dimensions: { width: 2, depth: 1.5, height: 0.012 },
      },
    };
    expect(productObject(product, "rug").dimensions).toEqual(
      product.measurement.dimensions,
    );
  });
});
