import { describe, expect, it } from "bun:test";
import type {
  DesignBrief,
  ProductCandidate,
  RoomObject,
  RoomSnapshot,
  ZoneRequest,
} from "../shared/contracts";
import { importRoomPlan } from "../shared/capture/roomplan";
import { applyDesignCommands, designPlacementIssue } from "../shared/design";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { applyProposal, findPlacement } from "../shared/geometry";
import {
  buildDesignPlan,
  describeScope,
  planScope,
  reserveZones,
} from "../shared/planner";
import {
  buildSpaceModel,
  rectangleRing,
  ringInside,
  ringsOverlap,
} from "../shared/planner/space";
import * as slotRules from "../shared/planner/slots";
import { describeSlots, findSlots, type Slot } from "../shared/planner/slots";

// 4.8 × 4.2 m, no furniture and no openings.
const emptyRoom: RoomSnapshot = { ...sampleRoom, objects: [], openings: [] };
const brief: DesignBrief = { ...sampleBrief, budgetCents: 0 };
const slotRing = (slot: Slot) =>
  rectangleRing(slot.center, slot.width, slot.depth, slot.rotationY);
const bodyRing = (zone: {
  position: { x: number; z: number };
  footprint: { width: number; depth: number };
  rotationY: number;
}) =>
  rectangleRing(
    { x: zone.position.x, z: zone.position.z },
    zone.footprint.width,
    zone.footprint.depth,
    zone.rotationY,
  );
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
  slotId: null,
  desiredFootprint: { width: 0.5, depth: 0.5 },
  desiredHeight: null,
  miscellaneous: [],
  ...extra,
});
const request = (zones: ZoneRequest[]) => ({
  summary: "Plan the room.",
  spacing: "balanced",
  zones,
});
const withObject = (
  room: RoomSnapshot,
  object: Pick<RoomObject, "id" | "name" | "category" | "dimensions" | "position"> & {
    yaw?: number;
  },
): RoomSnapshot => ({
  ...room,
  objects: [
    ...room.objects,
    {
      ...sampleRoom.objects[0],
      ...object,
      rotation: { x: 0, y: object.yaw ?? 0, z: 0 },
    },
  ],
});
const rug = (
  id: string,
  dimensions: { width: number; depth: number; height: number },
): ProductCandidate => ({
  ...sampleProducts[0],
  id,
  name: `Rug ${id}`,
  category: "rug",
  availability: "available",
  measurement: {
    ...sampleProducts[0].measurement,
    source: "confirmed",
    dimensions,
  },
});

describe("catalog rug dimensions", () => {
  const catalogRug = rug("catalog-rug", { width: 1.6, depth: 2.3, height: 0.01 });

  it("survive placement and proposal validation in scanned and rectangular rooms", () => {
    for (const room of [importRoomPlan(syntheticRoomPlan), sampleRoom]) {
      const object = findPlacement(room, catalogRug);
      expect(object?.dimensions).toEqual(catalogRug.measurement.dimensions!);
      const next = applyProposal(
        room,
        {
          id: "rug-proposal",
          roomId: room.id,
          baseRevision: room.revision,
          summary: "Place the rug",
          additions: [object!],
        },
        [catalogRug],
        brief,
      );
      expect(next.revision).toBe(room.revision + 1);
    }
  });

  it("survive add, replace and arrange commands, lying under furniture", () => {
    const thicker = rug("thicker-rug", { width: 1.2, depth: 1.8, height: 0.015 });
    const products = [catalogRug, thicker];
    const added = applyDesignCommands(
      sampleRoom,
      [{ type: "add", productId: catalogRug.id, instanceId: "rug-1", nearObjectId: "owned-bed" }],
      products,
      brief,
    );
    const placed = added.objects.find((object) => object.id === "rug-1")!;
    expect(placed.dimensions).toEqual(catalogRug.measurement.dimensions!);
    expect(designPlacementIssue(added, placed)).toBeNull();
    const replaced = applyDesignCommands(
      added,
      [{ type: "replace", objectId: "rug-1", productId: thicker.id }],
      products,
      brief,
    );
    const arranged = applyDesignCommands(
      replaced,
      [{ type: "arrange", objectId: "rug-1", nearObjectId: "owned-bed" }],
      products,
      brief,
    );
    for (const room of [replaced, arranged]) {
      const object = room.objects.find((item) => item.id === "rug-1")!;
      expect(object.dimensions).toEqual(thicker.measurement.dimensions!);
      expect(designPlacementIssue(room, object)).toBeNull();
    }
  });
});

describe("free-floor slots", () => {
  it("finds empty rectangles, largest first, inside the floor and clear of furniture and doors", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    const areas = slots.map((slot) => slot.width * slot.depth);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    for (const slot of slots) {
      expect(slot.width).toBeGreaterThanOrEqual(0.5);
      expect(slot.depth).toBeGreaterThanOrEqual(0.5);
      expect(ringInside(slotRing(slot), model.floor)).toBe(true);
      for (const obstacle of model.obstacles)
        expect(ringsOverlap(slotRing(slot), obstacle.footprint)).toBe(false);
      for (const door of model.clearances)
        expect(ringsOverlap(slotRing(slot), door.footprint)).toBe(false);
    }
    const rings = slots.map(slotRing);
    for (let i = 0; i < rings.length; i++)
      for (let j = i + 1; j < rings.length; j++)
        expect(ringsOverlap(rings[i], rings[j])).toBe(false);
    expect(slots.some((slot) => slot.near.some((name) => /bed|desk/i.test(name)))).toBe(true);
    expect(describeSlots(slots)).toContain("Slot 1 (slot-1)");
    expect(findSlots(model, { minSide: 10 })).toEqual([]);
  });

  it("never advertises floor across a thin or rotated divider", () => {
    for (const yaw of [0, 0.63]) {
      const room = withObject(emptyRoom, {
        id: "divider",
        name: "Thin room divider",
        category: "storage",
        dimensions: { width: 2, height: 1.8, depth: 0.02 },
        position: { x: 2.4, y: 0, z: 2.5 },
        yaw,
      });
      const model = buildSpaceModel(room);
      const slots = findSlots(model, { count: 6 });
      for (const slot of slots) {
        expect(ringInside(slotRing(slot), model.floor)).toBe(true);
        for (const obstacle of model.obstacles)
          expect(ringsOverlap(slotRing(slot), obstacle.footprint)).toBe(false);
      }
      // Floor on both sides of the divider is still offered.
      expect(slots.length).toBeGreaterThan(1);
    }
  });

  it("splits open floor into several wall-backed slots instead of one room-sized slot", () => {
    const model = buildSpaceModel(emptyRoom);
    const slots = findSlots(model, { count: 5 });
    expect(slots.length).toBeGreaterThanOrEqual(4);
    for (const slot of slots) {
      // Pieces stand against a wall; no slot is deeper than a bed needs.
      expect(slot.depth).toBeLessThanOrEqual(2.4);
      expect(slot.width).toBeLessThanOrEqual(3.2);
      expect(ringInside(slotRing(slot), model.floor)).toBe(true);
    }
    const rings = slots.map(slotRing);
    for (let i = 0; i < rings.length; i++)
      for (let j = i + 1; j < rings.length; j++)
        expect(ringsOverlap(rings[i], rings[j])).toBe(false);
  });
});

describe("slot reservation", () => {
  it("places a floor piece inside its slot, back against the slot's wall edge", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    const target = slots[0];
    const { zones, rejected } = reserveZones(
      sampleRoom,
      model,
      [piece("sofa", "loveseat", 1, { slotId: target.id, desiredFootprint: { width: 1.5, depth: 0.85 } })],
      "balanced",
      sampleRoom.dimensions.height,
      [],
      slots,
    );
    expect(rejected).toEqual([]);
    const sofa = zones[0];
    expect(sofa.rotationY).toBeCloseTo(target.rotationY, 5);
    expect(ringInside(bodyRing(sofa), [slotRing(target)])).toBe(true);
    const s = Math.sin(target.rotationY),
      c = Math.cos(target.rotationY);
    const back = {
      x: target.center.x - (s * target.depth) / 2,
      z: target.center.z - (c * target.depth) / 2,
    };
    const gap = (sofa.position.x - back.x) * s + (sofa.position.z - back.z) * c;
    expect(gap - sofa.footprint.depth / 2).toBeLessThanOrEqual(sofa.margins.back + 0.03);
  });

  it("never accepts a body outside the selected slot", () => {
    const model = buildSpaceModel(sampleRoom);
    const slots = findSlots(model);
    for (const slot of slots) {
      const { zones, rejected } = reserveZones(
        sampleRoom,
        model,
        [piece("table", "console table", 1, { slotId: slot.id, desiredFootprint: { width: 5, depth: 5 } })],
        "balanced",
        sampleRoom.dimensions.height,
        [],
        slots,
      );
      expect(zones.length + rejected.length).toBe(1);
      for (const zone of zones) {
        expect(ringInside(bodyRing(zone), [slotRing(slot)])).toBe(true);
        expect(zone.footprint.width).toBeLessThanOrEqual(slot.width);
        expect(zone.footprint.depth).toBeLessThanOrEqual(slot.depth);
      }
      for (const item of rejected) expect(item.reason).toContain(slot.id);
    }
  });

  it("gives a slot to one floor piece and rejects reused or unknown slots by name", () => {
    const model = buildSpaceModel(emptyRoom);
    const slots = findSlots(model, { count: 2 });
    const { zones, rejected } = reserveZones(
      emptyRoom,
      model,
      [
        piece("chair", "accent chair", 1, { slotId: slots[0].id }),
        piece("lamp", "floor lamp", 2, { slotId: slots[0].id }),
        piece("stool", "stool", 3, { slotId: "slot-99" }),
      ],
      "balanced",
      emptyRoom.dimensions.height,
      [],
      slots,
    );
    expect(zones.map((zone) => zone.id)).toEqual(["chair"]);
    expect(ringInside(bodyRing(zones[0]), [slotRing(slots[0])])).toBe(true);
    expect(rejected.map((item) => item.zoneId)).toEqual(["lamp", "stool"]);
    expect(rejected[0].reason).toContain(slots[0].id);
    expect(rejected[1].reason).toContain("slot-99");
  });

  it("keeps a piece without a slot out of a slot another piece still needs", () => {
    const model = buildSpaceModel(emptyRoom);
    const slots = findSlots(model, { count: 3 });
    const { zones, rejected } = reserveZones(
      emptyRoom,
      model,
      [
        piece("bookcase", "bookcase", 1, { desiredFootprint: { width: 1, depth: 0.4 } }),
        piece("desk", "desk", 2, { slotId: slots[0].id, desiredFootprint: { width: 1.2, depth: 0.6 } }),
      ],
      "balanced",
      emptyRoom.dimensions.height,
      [],
      slots,
    );
    expect(rejected).toEqual([]);
    const bookcase = zones.find((zone) => zone.id === "bookcase")!;
    const desk = zones.find((zone) => zone.id === "desk")!;
    expect(ringsOverlap(bodyRing(bookcase), slotRing(slots[0]))).toBe(false);
    expect(ringInside(bodyRing(desk), [slotRing(slots[0])])).toBe(true);
  });

  it("steps a bed down to the standard frame its slot holds", () => {
    const narrow: RoomSnapshot = {
      ...emptyRoom,
      dimensions: { width: 1.5, depth: 3.5, height: 2.7 },
    };
    const model = buildSpaceModel(narrow);
    const slots = findSlots(model);
    const { zones } = reserveZones(
      narrow,
      model,
      [piece("bed", "queen bed", 1, { slotId: slots[0].id, desiredFootprint: { width: 1.65, depth: 2.15 } })],
      "balanced",
      narrow.dimensions.height,
      [],
      slots,
    );
    expect(zones[0].category).toBe("twin bed");
    expect(zones[0].footprint.width).toBe(1.1);
    expect(ringInside(bodyRing(zones[0]), [slotRing(slots[0])])).toBe(true);
  });

  it("keeps a requested king whose front reaches only empty floor of a later slot", () => {
    const kingBrief: DesignBrief = {
      ...brief,
      purpose: "bedroom",
      wants: [
        { category: "king bed", notes: "" },
        { category: "desk", notes: "" },
      ],
    };
    const model = buildSpaceModel(emptyRoom);
    const slots = findSlots(model, { count: planScope(kingBrief).maxZones });
    const zones = (bedPriority: number) => [
      piece("bed", "king bed", bedPriority, {
        slotId: slots[0].id,
        desiredFootprint: { width: 2.05, depth: 2.2 },
      }),
      piece("desk", "desk", 3 - bedPriority, {
        slotId: slots[1].id,
        desiredFootprint: { width: 1.2, depth: 0.6 },
      }),
    ];
    // The defining bed stays priority 1, as the planner requires.
    const first = buildDesignPlan({
      room: emptyRoom,
      brief: kingBrief,
      products: [],
      request: request(zones(1)),
    }).plan;
    expect(first.rejected).toEqual([]);
    // Reserving the desk first gives the same spots: order alone never
    // shrinks a piece when both fit.
    const reversed = reserveZones(emptyRoom, model, zones(2), "balanced", emptyRoom.dimensions.height, [], slots);
    expect(reversed.rejected).toEqual([]);
    const spots = (list: { id: string; category: string; position: unknown; footprint: unknown }[]) =>
      list.map((zone) => JSON.stringify([zone.id, zone.category, zone.position, zone.footprint])).sort();
    expect(spots(first.zones)).toEqual(spots(reversed.zones));
    const bed = first.zones.find((zone) => zone.id === "bed")!;
    const desk = first.zones.find((zone) => zone.id === "desk")!;
    expect(bed.category).toBe("king bed");
    expect(bed.footprint).toEqual({ width: 2.05, depth: 2.2 });
    expect(desk.footprint).toEqual({ width: 1.2, depth: 0.6 });
    expect(ringInside(bodyRing(bed), [slotRing(slots[0])])).toBe(true);
    expect(ringInside(bodyRing(desk), [slotRing(slots[1])])).toBe(true);
    // Each piece keeps a clear strip in front of it.
    const frontStrip = (zone: typeof bed) => {
      const reach = zone.footprint.depth / 2 + 0.15;
      return rectangleRing(
        {
          x: zone.position.x + Math.sin(zone.rotationY) * reach,
          z: zone.position.z + Math.cos(zone.rotationY) * reach,
        },
        zone.footprint.width,
        0.3,
        zone.rotationY,
      );
    };
    expect(ringsOverlap(frontStrip(bed), bodyRing(desk))).toBe(false);
    expect(ringsOverlap(frontStrip(desk), bodyRing(bed))).toBe(false);
    // The exact plan places both catalog products in one atomic command.
    const products: ProductCandidate[] = first.zones.map((zone) => ({
      ...sampleProducts[0],
      id: zone.id,
      name: zone.category,
      category: zone.category,
      availability: "available",
      measurement: {
        ...sampleProducts[0].measurement,
        source: "confirmed",
        dimensions: { ...zone.footprint, height: zone.id === "bed" ? 0.6 : 0.75 },
      },
    }));
    const placed = applyDesignCommands(
      emptyRoom,
      first.zones.map((zone) => ({ type: "add" as const, productId: zone.id, instanceId: zone.id, zone })),
      products,
      kingBrief,
      "agent",
    );
    expect(placed.objects.map((object) => object.id).sort()).toEqual(["bed", "desk"]);
    for (const object of placed.objects) expect(designPlacementIssue(placed, object)).toBeNull();
  });
});

describe("planner slot and count rules", () => {
  const wants = ["accent chair", "floor lamp", "plant", "bookcase", "stool"];
  const directed: DesignBrief = {
    ...brief,
    wants: wants.map((category) => ({ category, notes: "" })),
  };

  it("place a directed list longer than four, one piece per slot and the rest in free floor", () => {
    const scope = planScope(directed);
    expect(scope.maxZones).toBe(5);
    const slots = findSlots(buildSpaceModel(emptyRoom), { count: scope.maxZones });
    expect(slots.length).toBeGreaterThanOrEqual(4);
    const zones = wants.map((category, index) =>
      piece(category, category, index + 1, { slotId: slots[index]?.id ?? null }),
    );
    const { plan } = buildDesignPlan({
      room: emptyRoom,
      brief: directed,
      products: [],
      request: request(zones),
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.zones.map((zone) => zone.id).sort()).toEqual([...wants].sort());
    wants.forEach((category, index) => {
      const zone = plan.zones.find((item) => item.id === category)!;
      if (slots[index]) expect(ringInside(bodyRing(zone), [slotRing(slots[index])])).toBe(true);
    });
  });

  it("place floor pieces beyond the chosen slots in the remaining free floor", () => {
    const slots = findSlots(buildSpaceModel(emptyRoom), { count: planScope(directed).maxZones });
    const zones = wants.map((category, index) =>
      piece(category, category, index + 1, { slotId: index === 0 ? slots[0].id : null }),
    );
    const { plan } = buildDesignPlan({
      room: emptyRoom,
      brief: directed,
      products: [],
      request: request(zones),
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.zones).toHaveLength(wants.length);
    const chair = plan.zones.find((zone) => zone.id === "accent chair")!;
    expect(ringInside(bodyRing(chair), [slotRing(slots[0])])).toBe(true);
  });

  it("let an accessory-only request plan no floor furniture", () => {
    const art = piece("art", "wall art", 1, {
      mount: "wall",
      desiredFootprint: { width: 0.6, depth: 0.04 },
      desiredHeight: 0.6,
    });
    const { plan } = buildDesignPlan({
      room: emptyRoom,
      brief: { ...brief, wants: [{ category: "wall art", notes: "" }] },
      products: [],
      request: request([art]),
    });
    expect(plan.zones.map((zone) => zone.mount)).toEqual(["wall"]);
    expect(plan.rejected).toEqual([]);
  });

  it("send reused or unknown slots back to the model with a satisfiable fix", () => {
    const slots = findSlots(buildSpaceModel(emptyRoom), { count: planScope(directed).maxZones });
    const plan = (slotIds: (string | null)[]) =>
      buildDesignPlan({
        room: emptyRoom,
        brief: directed,
        products: [],
        request: request(
          wants.map((category, index) =>
            piece(category, category, index + 1, { slotId: slotIds[index] ?? null }),
          ),
        ),
      });
    expect(() => plan([slots[0].id, slots[0].id])).toThrow(/slot-1.*slotId null/);
    expect(() => plan(["slot-99"])).toThrow(/slot-99.*slotId null/);
  });

  it("send a requested or defining piece that misses its slot back for another slot", () => {
    const model = buildSpaceModel(sampleRoom);
    const requested: DesignBrief = { ...brief, wants: [{ category: "twin bed", notes: "" }] };
    const slots = findSlots(model, { count: planScope(requested).maxZones });
    const tight = slots.find((slot) => slot.width < 1.12 || slot.depth < 2.1);
    expect(tight).toBeDefined();
    const bed = piece("bed", "twin bed", 1, {
      slotId: tight!.id,
      desiredFootprint: { width: 1.1, depth: 2.05 },
    });
    expect(() =>
      buildDesignPlan({ room: sampleRoom, brief: requested, products: [], request: request([bed]) }),
    ).toThrow(new RegExp(`${tight!.id}.*slotId null`));

    const bedroom: DesignBrief = { ...brief, purpose: "bedroom" };
    const emptySlots = findSlots(buildSpaceModel(emptyRoom), { count: planScope(bedroom).maxZones });
    const shallow = emptySlots.find((slot) => slot.width < 1.12 || slot.depth < 2.1);
    expect(shallow).toBeDefined();
    let message = "";
    try {
      buildDesignPlan({
        room: emptyRoom,
        brief: bedroom,
        products: [],
        request: request([{ ...bed, category: "bed", query: "bed", slotId: shallow!.id }]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(shallow!.id);
    expect(message).toContain("slotId null");
    // The planner retries every rejection except an unreservable defining piece.
    expect(message).not.toMatch(/defining .+ could not be reserved/i);
  });

  it("state rules that every supported request can satisfy", () => {
    const rules = (slotRules as Record<string, unknown>).SLOT_RULES;
    expect(typeof rules).toBe("string");
    expect(rules).toContain("slotId null");
    const texts = [
      String(rules),
      describeScope(planScope(directed), "study"),
      describeScope(planScope({ ...brief, wants: [{ category: "wall art", notes: "" }] }), "study"),
      describeScope(planScope({ ...brief, purpose: "bedroom" }), "bedroom"),
      describeSlots([]),
    ];
    for (const text of texts)
      expect(text).not.toMatch(/must take one slot|one per slot|at least one floor piece|at most 4 items/i);
    expect(texts[1]).toContain("at most 5 pieces");
    expect(describeSlots([])).toContain("slotId null");
  });
});

// Beds and the furniture that goes with them, across rooms, relations and slot
// choices. Each case must keep the priority-1 king exactly as it is reserved
// alone, keep slotted bodies in their slots, never overlap bodies or doors,
// keep unrelated front strips clear (a companion and its host are exempt from
// each other's fronts only), and place atomically with catalog dimensions.
describe("bed and companion matrix", () => {
  const rooms: Record<string, RoomSnapshot> = {
    open: emptyRoom,
    narrow: { ...emptyRoom, dimensions: { width: 2.2, depth: 3, height: 2.7 } },
    door: { ...sampleRoom, objects: [] },
  };
  const king = piece("bed", "king bed", 1, { desiredFootprint: { width: 2.05, depth: 2.2 } });
  const desk = (priority: number) =>
    piece("desk", "desk", priority, { desiredFootprint: { width: 1.2, depth: 0.6 } });
  const nightstand = (relatedObjectId: string | null) =>
    piece("nightstand", "nightstand", 2, {
      relatedObjectId,
      desiredFootprint: { width: 0.5, depth: 0.4 },
    });
  const sets: Record<string, ZoneRequest[]> = {
    "king and desk": [king, desk(2)],
    "king and its nightstand": [king, nightstand("bed")],
    "king and an unrelated nightstand": [king, nightstand(null)],
    "king, its nightstand and a desk": [king, nightstand("bed"), desk(3)],
  };
  const modes = ["every piece slotted", "bed slotted", "no slots"] as const;
  const strip = (zone: { position: { x: number; z: number }; footprint: { width: number; depth: number }; rotationY: number; margins: { front: number } }) => {
    const depth = Math.max(Math.min(zone.margins.front, 0.3), 0.01);
    const reach = zone.footprint.depth / 2 + depth / 2;
    return rectangleRing(
      {
        x: zone.position.x + Math.sin(zone.rotationY) * reach,
        z: zone.position.z + Math.cos(zone.rotationY) * reach,
      },
      zone.footprint.width,
      depth,
      zone.rotationY,
    );
  };

  for (const [roomName, room] of Object.entries(rooms))
    for (const [setName, set] of Object.entries(sets))
      for (const mode of modes)
        it(`${setName}, ${mode}, ${roomName} room`, () => {
          const bedroom: DesignBrief = {
            ...brief,
            purpose: "bedroom",
            wants: set.map((zone) => ({ category: zone.category, notes: "" })),
          };
          const model = buildSpaceModel(room);
          const slots = findSlots(model, { count: planScope(bedroom).maxZones });
          const zones = set.map((zone, index) => ({
            ...zone,
            slotId:
              mode === "no slots" || (mode === "bed slotted" && index > 0)
                ? null
                : (slots[index]?.id ?? null),
          }));
          const { plan } = buildDesignPlan({ room, brief: bedroom, products: [], request: request(zones) });

          // Later pieces never change the priority-1 king.
          const alone = reserveZones(room, model, [zones[0]], "balanced", room.dimensions.height, [], slots).zones[0];
          const bed = plan.zones.find((zone) => zone.id === "bed")!;
          expect(alone.category).toBe("king bed");
          expect([bed.category, bed.footprint, bed.position, bed.rotationY]).toEqual([
            alone.category,
            alone.footprint,
            alone.position,
            alone.rotationY,
          ]);
          // Only a desk without a slot misses the narrow room, as on main.
          const unslottedDesk = zones.some((zone) => zone.id === "desk" && !zone.slotId);
          expect(plan.rejected.map((item) => item.zoneId)).toEqual(
            roomName === "narrow" && unslottedDesk ? ["desk"] : [],
          );

          for (const zone of plan.zones) {
            const slotId = zones.find((item) => item.id === zone.id)?.slotId;
            const slot = slots.find((item) => item.id === slotId);
            if (slot) expect(ringInside(bodyRing(zone), [slotRing(slot)])).toBe(true);
            for (const door of model.clearances)
              expect(ringsOverlap(bodyRing(zone), door.footprint)).toBe(false);
          }
          for (const a of plan.zones)
            for (const b of plan.zones) {
              if (a === b) continue;
              expect(ringsOverlap(bodyRing(a), bodyRing(b))).toBe(false);
              const pair = a.relatedObjectId === b.id || b.relatedObjectId === a.id;
              if (!pair) expect(ringsOverlap(bodyRing(a), strip(b))).toBe(false);
            }

          const products: ProductCandidate[] = plan.zones.map((zone) => ({
            ...sampleProducts[0],
            id: zone.id,
            name: zone.category,
            category: zone.category,
            availability: "available",
            measurement: {
              ...sampleProducts[0].measurement,
              source: "confirmed",
              dimensions: { ...zone.footprint, height: zone.id === "bed" ? 0.6 : 0.75 },
            },
          }));
          const placed = applyDesignCommands(
            room,
            plan.zones.map((zone) => ({ type: "add" as const, productId: zone.id, instanceId: zone.id, zone })),
            products,
            bedroom,
            "agent",
          );
          expect(placed.objects).toHaveLength(plan.zones.length);
          for (const object of placed.objects) {
            expect(object.dimensions).toEqual(
              products.find((product) => product.id === object.id)!.measurement.dimensions!,
            );
            expect(designPlacementIssue(placed, object)).toBeNull();
          }
        });

  it("keeps a related nightstand at its size but shrinks an unrelated one off the bed's front", () => {
    const room = rooms.narrow;
    const bedroom: DesignBrief = {
      ...brief,
      purpose: "bedroom",
      wants: [
        { category: "king bed", notes: "" },
        { category: "nightstand", notes: "" },
      ],
    };
    const slots = findSlots(buildSpaceModel(room), { count: planScope(bedroom).maxZones });
    const plan = (relatedObjectId: string | null) =>
      buildDesignPlan({
        room,
        brief: bedroom,
        products: [],
        request: request([
          { ...king, slotId: slots[0].id },
          { ...nightstand(relatedObjectId), slotId: slots[1].id },
        ]),
      }).plan;
    const related = plan("bed").zones.find((zone) => zone.id === "nightstand")!;
    const unrelated = plan(null).zones.find((zone) => zone.id === "nightstand")!;
    const bed = plan(null).zones.find((zone) => zone.id === "bed")!;
    expect(related.footprint).toEqual({ width: 0.5, depth: 0.4 });
    expect(unrelated.footprint.width).toBeLessThan(0.5);
    expect(ringsOverlap(strip(unrelated), bodyRing(bed))).toBe(false);
  });

  it("never lets a companion stand on its host", () => {
    const room: RoomSnapshot = { ...emptyRoom, dimensions: { width: 2.1, depth: 2.6, height: 2.7 } };
    const bedroom: DesignBrief = {
      ...brief,
      purpose: "bedroom",
      wants: [
        { category: "king bed", notes: "" },
        { category: "nightstand", notes: "" },
      ],
    };
    const slots = findSlots(buildSpaceModel(room), { count: planScope(bedroom).maxZones });
    const { plan } = buildDesignPlan({
      room,
      brief: bedroom,
      products: [],
      request: request([
        { ...king, slotId: slots[0].id },
        piece("nightstand", "nightstand", 2, {
          relatedObjectId: "bed",
          desiredFootprint: { width: 0.9, depth: 0.7 },
        }),
      ]),
    });
    expect(plan.zones.map((zone) => [zone.id, zone.category])).toEqual([["bed", "king bed"]]);
    expect(plan.rejected).toEqual([
      {
        zoneId: "nightstand",
        reason: "Could not reserve 0.9 × 0.7 m for nightstand: overlaps another reserved zone.",
      },
    ]);
  });

  it("rejects a bed whose dimensions differ from its catalog variant", () => {
    const room = rooms.narrow;
    const bedroom: DesignBrief = { ...brief, purpose: "bedroom", wants: [{ category: "king bed", notes: "" }] };
    const slots = findSlots(buildSpaceModel(room), { count: planScope(bedroom).maxZones });
    const { plan } = buildDesignPlan({
      room,
      brief: bedroom,
      products: [],
      request: request([{ ...king, slotId: slots[0].id }]),
    });
    const zone = plan.zones[0];
    const product: ProductCandidate = {
      ...sampleProducts[0],
      id: "king",
      name: "King bed",
      category: "bed",
      availability: "available",
      measurement: {
        ...sampleProducts[0].measurement,
        source: "confirmed",
        dimensions: { ...zone.footprint, height: 0.6 },
      },
    };
    const object = applyDesignCommands(
      room,
      [{ type: "add", productId: product.id, instanceId: "king", zone }],
      [product],
      bedroom,
    ).objects[0];
    const proposal = (dimensions: typeof object.dimensions) => ({
      id: "king-proposal",
      roomId: room.id,
      baseRevision: room.revision,
      summary: "Place the king",
      additions: [{ ...object, dimensions }],
    });
    expect(applyProposal(room, proposal(object.dimensions), [product], bedroom).revision).toBe(room.revision + 1);
    expect(() =>
      applyProposal(room, proposal({ ...object.dimensions, width: 1.65 }), [product], bedroom),
    ).toThrow(/dimensions must match/);
  });
});
