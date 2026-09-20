import { describe, expect, it } from "bun:test";
import {
  applyDesignCommands,
  designPlacementIssue,
  objectInZone,
  productObject,
  suggestPlacement,
} from "../shared/design";
import { selectionTotal } from "../shared/budget";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { sampleDesignAssets } from "../shared/fixtures/design";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import {
  importRoomPlan,
  parseRoomFile,
  savedRoomSchema,
} from "../shared/capture/roomplan";
import { buildSpaceModel, reserveZones } from "../shared/planner";
import type {
  ProductCandidate,
  RoomSnapshot,
  ZoneRequest,
} from "../shared/contracts";

const capture = () => importRoomPlan(syntheticRoomPlan, "Sample", true);
const add = (room: RoomSnapshot, index = 0, id = "lamp") =>
  applyDesignCommands(
    room,
    [{ type: "add", instanceId: id, productId: sampleProducts[index].id }],
    sampleProducts,
    sampleBrief,
  );
const request = (
  mount: ZoneRequest["mount"],
  extra: Partial<ZoneRequest> = {},
): ZoneRequest => ({
  id: "zone",
  purpose: "Light the desk",
  category: "lighting",
  query: "lamp",
  mount,
  anchor: "anywhere",
  relatedObjectId: null,
  desiredFootprint: { width: 0.3, depth: 0.3 },
  desiredHeight: 0.4,
  miscellaneous: [],
  priority: 1,
  ...extra,
});

describe("the editable room design", () => {
  it("automatically puts small plants on furniture near the requested anchor without locking them", () => {
    const plant: ProductCandidate = {
      ...sampleProducts[0],
      id: "small-plants",
      name: "Small potted plants",
      category: "plants",
      measurement: {
        ...sampleProducts[0].measurement,
        dimensions: { width: 0.24, height: 0.14, depth: 0.24 },
      },
    };
    const placed = applyDesignCommands(
      sampleRoom,
      [
        {
          type: "add",
          productId: plant.id,
          instanceId: "plants",
          nearObjectId: "owned-bed",
        },
      ],
      [plant],
      sampleBrief,
      "agent",
    );
    const object = placed.objects.find((item) => item.id === "plants")!;
    expect(object.mount).toBe("surface");
    expect(object.supportId).toBe("owned-desk");
    expect(object.position.y).toBeGreaterThan(0.4);
    expect(object.locked).toBe(false);
    expect(designPlacementIssue(placed, object)).toBeNull();
    const rearranged = applyDesignCommands(
      placed,
      [{ type: "arrange", objectId: object.id, nearObjectId: "owned-desk" }],
      [plant],
      sampleBrief,
      "agent",
    );
    expect(
      rearranged.objects.find((item) => item.id === object.id)?.mount,
    ).toBe("surface");
    expect(rearranged.objects.slice(0, sampleRoom.objects.length)).toEqual(
      sampleRoom.objects,
    );
    const locked = {
      ...rearranged,
      objects: rearranged.objects.map((item) =>
        item.id === object.id ? { ...item, locked: true } : item,
      ),
    };
    expect(() =>
      applyDesignCommands(
        locked,
        [{ type: "arrange", objectId: object.id }],
        [plant],
        sampleBrief,
        "agent",
      ),
    ).toThrow("locked in place");
    expect(() =>
      applyDesignCommands(
        { ...sampleRoom, objects: [] },
        [{ type: "add", productId: plant.id, instanceId: "plants" }],
        [plant],
        sampleBrief,
      ),
    ).toThrow("No suitable clear placement");
  });

  it("places the whole sample selection in a captured room and preserves owned furniture", () => {
    const room = capture();
    const next = applyDesignCommands(
      room,
      sampleProducts.map((p) => ({
        type: "add",
        productId: p.id,
        instanceId: p.id,
      })),
      sampleProducts,
      sampleBrief,
    );
    expect(next.objects.slice(0, room.objects.length)).toEqual(room.objects);
    expect(next.revision).toBe(room.revision + 1);
    expect(selectionTotal(next, sampleProducts)).toBe(39600);
    for (const object of next.objects.filter((item) => !item.owned))
      expect(designPlacementIssue(next, object)).toBeNull();
    expect(next.objects.find((item) => item.category === "art")?.mount).toBe(
      "wall",
    );
  });

  it("keeps counts and prices correct across sequential additions, duplicates and removal", () => {
    let next = add(capture());
    next = add(next, 1, "rug");
    next = add(next, 0, "lamp-2");
    expect(selectionTotal(next, sampleProducts)).toBe(28700);
    next = applyDesignCommands(
      next,
      [{ type: "remove", objectId: "lamp-2" }],
      sampleProducts,
      sampleBrief,
    );
    expect(selectionTotal(next, sampleProducts)).toBe(20800);
    expect(() => add(next, 0, "lamp")).toThrow("already");
  });

  it("enforces the final budget atomically and permits reducing an over-budget room", () => {
    const room = add(capture());
    const original = structuredClone(room);
    expect(() =>
      applyDesignCommands(
        room,
        [{ type: "add", productId: sampleProducts[1].id, instanceId: "rug" }],
        sampleProducts,
        { ...sampleBrief, budgetCents: 10000 },
      ),
    ).toThrow("budget");
    expect(room).toEqual(original);
    const cleared = applyDesignCommands(
      room,
      [{ type: "remove", objectId: "lamp" }],
      sampleProducts,
      { ...sampleBrief, budgetCents: 1000 },
    );
    expect(selectionTotal(cleared, sampleProducts)).toBe(0);
  });

  it("keeps product locks separate from placement locks, and agents cannot unlock them", () => {
    let room = add(capture());
    room = applyDesignCommands(
      room,
      [
        {
          type: "lock",
          objectId: "lamp",
          productLocked: true,
          placementLocked: false,
        },
      ],
      sampleProducts,
      sampleBrief,
    );
    expect(() =>
      applyDesignCommands(
        room,
        [{ type: "remove", objectId: "lamp" }],
        sampleProducts,
        sampleBrief,
      ),
    ).toThrow("kept");
    expect(() =>
      applyDesignCommands(
        room,
        [
          {
            type: "replace",
            objectId: "lamp",
            productId: sampleProducts[2].id,
          },
        ],
        sampleProducts,
        sampleBrief,
      ),
    ).toThrow("kept");
    const lamp = room.objects.find((item) => item.id === "lamp")!;
    expect(() =>
      applyDesignCommands(
        room,
        [
          {
            type: "move",
            objectId: lamp.id,
            position: lamp.position,
            rotationY: lamp.rotation.y,
          },
        ],
        sampleProducts,
        sampleBrief,
      ),
    ).not.toThrow();
    expect(() =>
      applyDesignCommands(
        room,
        [
          {
            type: "lock",
            objectId: lamp.id,
            productLocked: false,
            placementLocked: false,
          },
        ],
        sampleProducts,
        sampleBrief,
        "agent",
      ),
    ).toThrow("Only the user");
    room = applyDesignCommands(
      room,
      [
        {
          type: "lock",
          objectId: lamp.id,
          productLocked: false,
          placementLocked: true,
        },
      ],
      sampleProducts,
      sampleBrief,
    );
    expect(() =>
      applyDesignCommands(
        room,
        [
          {
            type: "move",
            objectId: lamp.id,
            position: lamp.position,
            rotationY: 0,
          },
        ],
        sampleProducts,
        sampleBrief,
      ),
    ).toThrow("locked");
  });

  it("supports a cheaper replacement while keeping its instance and placement", () => {
    const cheaper: ProductCandidate = {
      ...sampleProducts[0],
      id: "warmer-lamp",
      priceCents: 1900,
      color: "#bbaa88",
    };
    const room = add(capture());
    const before = room.objects.find((item) => item.id === "lamp")!;
    const next = applyDesignCommands(
      room,
      [{ type: "replace", objectId: "lamp", productId: cheaper.id }],
      [...sampleProducts, cheaper],
      sampleBrief,
    );
    const after = next.objects.find((item) => item.id === "lamp")!;
    expect(after.position).toEqual(before.position);
    expect(after.productId).toBe(cheaper.id);
    expect(after.color).toBe(cheaper.color);
    expect(selectionTotal(next, [...sampleProducts, cheaper])).toBe(1900);
  });

  it("rejects a concave cutout, a wall crossing, collisions and a doorway, then suggests a valid position", () => {
    const room = capture();
    const lamp = productObject(sampleProducts[0], "lamp");
    expect(
      designPlacementIssue(room, { ...lamp, position: { x: 5, y: 0, z: 4 } }),
    ).toContain("floor boundary");
    expect(
      designPlacementIssue(room, {
        ...lamp,
        position: room.objects[0].position,
      }),
    ).toContain("overlaps");
    const blocked = { ...lamp, position: { x: 1, y: 0, z: 4.2 } };
    expect(designPlacementIssue(room, blocked)).toContain("doorway");
    const suggested = suggestPlacement(room, blocked);
    expect(suggested).not.toBeNull();
    expect(designPlacementIssue(room, suggested!)).toBeNull();
    const internal = { ...sampleRoom, objects: [] };
    expect(
      designPlacementIssue(internal, {
        ...lamp,
        position: { x: -0.1, y: 0, z: 1 },
      }),
    ).toContain("floor boundary");
  });

  it("refuses missing floors and unresolved product dimensions", () => {
    expect(() => add({ ...capture(), floors: [] })).toThrow(
      "No suitable clear placement",
    );
    const unknown: ProductCandidate = {
      ...sampleProducts[0],
      measurement: {
        dimensions: null,
        source: "unknown",
        evidence: { kind: "none", detail: "" },
      },
    };
    expect(() =>
      applyDesignCommands(
        capture(),
        [{ type: "add", productId: unknown.id, instanceId: "x" }],
        [unknown],
        sampleBrief,
      ),
    ).toThrow("unknown");
  });

  it("puts tabletop products at the real host height and moves them with the host", () => {
    const room = {
      ...sampleRoom,
      objects: sampleRoom.objects.map((object) => ({
        ...object,
        locked: false,
      })),
    };
    const host = room.objects.find((object) => object.category === "desk")!;
    const model = buildSpaceModel(room);
    const zone = reserveZones(
      room,
      model,
      [request("surface", { relatedObjectId: host.id })],
      "balanced",
    ).zones[0];
    const product: ProductCandidate = {
      ...sampleProducts[0],
      id: "desk-lamp",
      measurement: {
        ...sampleProducts[0].measurement,
        dimensions: { width: 0.2, height: 0.3, depth: 0.2 },
      },
    };
    const object = objectInZone(room, product, "small-lamp", zone);
    expect(object.position.y).toBe(host.dimensions.height);
    let next = applyDesignCommands(
      room,
      [{ type: "add", productId: product.id, instanceId: object.id, zone }],
      [product],
      sampleBrief,
    );
    next = applyDesignCommands(
      next,
      [
        {
          type: "move",
          objectId: host.id,
          position: { ...host.position, z: host.position.z + 0.2 },
          rotationY: 0,
        },
      ],
      [product],
      sampleBrief,
    );
    expect(
      next.objects.find((item) => item.id === object.id)?.position.z,
    ).toBeCloseTo(object.position.z + 0.2);
    expect(() =>
      applyDesignCommands(
        next,
        [{ type: "remove", objectId: host.id }],
        [product],
        sampleBrief,
      ),
    ).toThrow("on");
  });

  it("does not let numeric product edits change the purchased footprint", () => {
    const room = add(capture());
    const object = room.objects.find((item) => item.id === "lamp")!;
    expect(() =>
      applyDesignCommands(
        room,
        [
          {
            type: "correct",
            object: {
              ...object,
              dimensions: { ...object.dimensions, width: 0.1 },
            },
          },
        ],
        sampleProducts,
        sampleBrief,
      ),
    ).toThrow("actual dimensions");
  });

  it("exports and restores the selection, prices, approximate assets and locks", () => {
    const room = add(capture());
    const saved = savedRoomSchema.parse({
      format: "rumi.room",
      version: 1,
      original: syntheticRoomPlan,
      room,
      design: {
        products: sampleProducts,
        assets: sampleDesignAssets,
        brief: sampleBrief,
      },
    });
    const restored = parseRoomFile(JSON.stringify(saved), "saved.json");
    expect(JSON.stringify(restored.room)).toBe(JSON.stringify(room));
    expect(selectionTotal(restored.room, restored.design!.products)).toBe(7900);
    expect(restored.design?.assets[0].scene?.parts.length).toBeGreaterThan(1);
  });
});
