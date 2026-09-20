import { describe, expect, it } from "bun:test";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { buildSpaceModel, rectangleRing, ringInside, ringsOverlap } from "../shared/planner/space";
import { describeSlots, findSlots } from "../shared/planner/slots";
import { buildDesignPlan, reserveZones } from "../shared/planner";
import { productObject } from "../shared/design/placement";

const emptyRoom = { ...sampleRoom, objects: [] };

describe("free-floor slots", () => {
  it("finds the largest empty rectangles, largest first, each against a wall", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    const areas = slots.map((slot) => slot.width * slot.depth);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    for (const slot of slots) {
      expect(slot.width).toBeGreaterThanOrEqual(0.5);
      expect(slot.depth).toBeGreaterThanOrEqual(0.5);
      const ring = rectangleRing(slot.center, slot.width, slot.depth, slot.rotationY);
      // Inside the room, clear of every piece that stands on the floor.
      expect(ringInside(ring, model.floor)).toBe(true);
      for (const obstacle of model.obstacles)
        if (obstacle.category !== "rug" && obstacle.bottom <= 0.9)
          expect(ringsOverlap(ring, obstacle.footprint)).toBe(false);
    }
    // Slots do not overlap one another.
    const rings = slots.map((slot) => rectangleRing(slot.center, slot.width, slot.depth, slot.rotationY));
    for (let i = 0; i < rings.length; i++)
      for (let j = i + 1; j < rings.length; j++) expect(ringsOverlap(rings[i], rings[j])).toBe(false);
    // The fixture bed and desk are what the slots sit next to.
    expect(slots.some((slot) => slot.near.some((name) => /bed|desk/i.test(name)))).toBe(true);
    expect(describeSlots(slots)).toContain("Slot 1 (slot-1)");
  });

  it("ignores slivers and hung objects, and gives an empty room the whole floor", () => {
    const model = buildSpaceModel(emptyRoom);
    const [first] = findSlots(model, { count: 1 });
    // 4.8 × 4.2 room less door strips: nearly the whole floor.
    expect(first.width * first.depth).toBeGreaterThan(14);
    expect(first.wallId).not.toBeNull();
    // A wall mirror above waist height does not cut the floor.
    const withMirror = {
      ...emptyRoom,
      objects: [
        {
          ...sampleRoom.objects[0], id: "mirror", name: "Wall mirror", category: "art" as const,
          dimensions: { width: 1, height: 1, depth: 0.03 }, position: { x: 2.4, y: 1.2, z: 0.02 },
        },
      ],
    };
    const [same] = findSlots(buildSpaceModel(withMirror), { count: 1 });
    expect(same.width * same.depth).toBeCloseTo(first.width * first.depth, 1);
    expect(findSlots(model, { minSide: 10 })).toEqual([]);
  });
});

describe("slot planning", () => {
  const base = { purpose: "p", anchor: "wall" as const, relatedObjectId: null, desiredHeight: null, miscellaneous: [], priority: 1 };

  it("places a floor piece in the slot the model chose, against the slot's wall", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    const target = slots[0];
    const { zones, rejected } = reserveZones(
      sampleRoom, model,
      [{ ...base, id: "sofa", category: "loveseat", query: "loveseat", mount: "floor", slotId: target.id, desiredFootprint: { width: 1.5, depth: 0.85 } }],
      "balanced", sampleRoom.dimensions.height, slots,
    );
    expect(rejected).toEqual([]);
    const sofa = zones[0];
    expect(sofa.rotationY).toBeCloseTo(target.rotationY, 5);
    // Inside the slot.
    const slotRing = rectangleRing(target.center, target.width + 0.02, target.depth + 0.02, target.rotationY);
    expect(ringInside(rectangleRing({ x: sofa.position.x, z: sofa.position.z }, sofa.footprint.width, sofa.footprint.depth, sofa.rotationY), [slotRing])).toBe(true);
    // Its back is at the slot's back edge, not floating mid-slot.
    const s = Math.sin(target.rotationY), c = Math.cos(target.rotationY);
    const back = { x: target.center.x - s * target.depth / 2, z: target.center.z - c * target.depth / 2 };
    const gap = (sofa.position.x - back.x) * s + (sofa.position.z - back.z) * c;
    expect(gap).toBeCloseTo(sofa.footprint.depth / 2 + 0.05 + 0.02, 1);
  });

  it("sizes a piece to its slot and steps a bed to the size that fits it", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    const small = slots.reduce((a, b) => (a.width * a.depth < b.width * b.depth ? a : b));
    const { zones } = reserveZones(
      sampleRoom, model,
      [{ ...base, id: "table", category: "console table", query: "console", mount: "floor", slotId: small.id, desiredFootprint: { width: 5, depth: 5 } }],
      "balanced", sampleRoom.dimensions.height, slots,
    );
    expect(zones[0].footprint.width).toBeLessThanOrEqual(small.width);
    expect(zones[0].footprint.depth).toBeLessThanOrEqual(small.depth);
    // A queen asked into a 1.5 m wide slot becomes a full.
    const narrow = { ...emptyRoom, dimensions: { width: 1.5, depth: 3.5, height: 2.7 }, openings: [] };
    if (narrow.shape !== "rectangle") throw new Error("fixture changed");
    const narrowModel = buildSpaceModel(narrow);
    const narrowSlots = findSlots(narrowModel);
    const bed = reserveZones(
      narrow, narrowModel,
      [{ ...base, id: "bed", category: "queen bed", query: "queen bed", mount: "floor", slotId: narrowSlots[0].id, desiredFootprint: { width: 1.6, depth: 2.1 } }],
      "balanced", narrow.dimensions.height, narrowSlots,
    ).zones[0];
    expect(bed.category).toBe("full bed");
    expect(bed.footprint.width).toBe(1.45);
  });

  it("keeps the plan to four items, rugs free, and always keeps what the user asked for", () => {
    const zone = (id: string, category: string, priority: number, mount: "floor" | "wall" | "under" = "floor") => ({
      ...base, id, category, query: category, mount, priority,
      desiredFootprint: mount === "under" ? { width: 1.6, depth: 2.3 } : mount === "wall" ? { width: 0.6, depth: 0.04 } : { width: 0.5, depth: 0.5 },
    });
    // Delegated: the model over-proposed; the lowest priorities go, the rug is free.
    const { plan } = buildDesignPlan({
      room: emptyRoom,
      brief: { ...sampleBrief, wants: [] },
      products: sampleProducts,
      request: {
        summary: "Too much.", spacing: "balanced",
        zones: [
          zone("chair", "accent chair", 1), zone("lamp", "floor lamp", 2), zone("plant", "plant", 3),
          zone("art", "wall art", 4, "wall"), zone("rug", "area rug", 5, "under"), zone("bookcase", "bookcase", 6),
          zone("stool", "stool", 7),
        ],
      },
    });
    const kept = plan.zones.map((item) => item.category);
    expect(kept).toContain("area rug");
    expect(kept.filter((category) => category !== "area rug")).toHaveLength(4);
    expect(kept).not.toContain("stool");
    expect(kept).not.toContain("bookcase");
    expect(plan.rejected.some((item) => item.reason.includes("keeps to 4 items"))).toBe(true);
    // Directed: five named items all stay; the cap grows to the user's list.
    const named = ["accent chair", "floor lamp", "plant", "bookcase", "stool"];
    const directed = buildDesignPlan({
      room: emptyRoom,
      brief: { ...sampleBrief, wants: named.map((category) => ({ category, notes: "" })) },
      products: sampleProducts,
      request: {
        summary: "All five.", spacing: "balanced",
        zones: named.map((category, index) => zone(category, category, index + 1)),
      },
    }).plan;
    expect(directed.zones.map((item) => item.category).sort()).toEqual([...named].sort());
  });

  it("gives a rug no thickness so it lies under anything", () => {
    const rug = productObject(
      { ...sampleProducts[0], id: "rug", category: "area rug", availability: "available", measurement: { ...sampleProducts[0].measurement, dimensions: { width: 1.6, depth: 2.3, height: 0.01 } } },
      "rug-1",
    );
    expect(rug.dimensions.height).toBe(0.005);
    expect(rug.mount).toBe("under");
  });
});
