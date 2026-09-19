import { describe, expect, it } from "bun:test";
import {
  measurementSchema,
  assetSchema,
  proposalSchema,
} from "../shared/contracts";
import {
  edgeCaseProducts,
  sampleAssets,
  sampleBrief,
  sampleProducts,
  sampleProposal,
  sampleRoom,
} from "../shared/fixtures";
import {
  applyProposal,
  findPlacement,
  placementIssue,
} from "../shared/geometry";
import { selectionTotal } from "../shared/budget";
import { fixtureSearch } from "../shared/fixtures/search";
import schema from "../convex/schema";

describe("team handoff", () => {
  it("creates Convex table validators from the shared contracts", () => {
    expect(Object.keys(schema.tables)).toEqual([
      "rooms",
      "products",
      "assets",
      "proposals",
      "projects",
      "messages",
      "images",
      "captures",
    ]);
  });
  it("keeps unknown measurements and pending models explicit", () => {
    expect(
      measurementSchema.safeParse({ source: "confirmed", dimensions: null })
        .success,
    ).toBe(false);
    expect(
      assetSchema.safeParse({ ...sampleAssets[0], status: "ready", url: null })
        .success,
    ).toBe(false);
    expect(
      findPlacement(sampleRoom, edgeCaseProducts.unknownDimensions),
    ).toBeNull();
  });
  it("accepts the search proposal while preserving existing furniture and budget", () => {
    const room = applyProposal(
      sampleRoom,
      sampleProposal,
      sampleProducts,
      sampleBrief,
    );
    expect(room.objects.slice(0, 2)).toEqual(sampleRoom.objects);
    expect(selectionTotal(room, sampleProducts)).toBe(7900);
    expect(room.revision).toBe(1);
    expect(sampleRoom.objects).toHaveLength(2);
  });
  it("rejects stale proposals and duplicate instances", () => {
    const room = applyProposal(
      sampleRoom,
      sampleProposal,
      sampleProducts,
      sampleBrief,
    );
    expect(() =>
      applyProposal(room, sampleProposal, sampleProducts, sampleBrief),
    ).toThrow("room changed");
    expect(() =>
      applyProposal(
        room,
        { ...sampleProposal, baseRevision: 1 },
        sampleProducts,
        sampleBrief,
      ),
    ).toThrow("already exists");
  });
  it("rejects oversized objects, collisions, and blocked doorways", () => {
    expect(findPlacement(sampleRoom, edgeCaseProducts.oversized)).toBeNull();
    const lamp = sampleProposal.additions[0];
    expect(
      placementIssue(sampleRoom, {
        ...lamp,
        position: sampleRoom.objects[0].position,
      }),
    ).toContain("overlaps");
    expect(
      placementIssue(sampleRoom, {
        ...lamp,
        position: { x: 0.7, y: 0, z: 3.7 },
      }),
    ).toContain("doorway");
  });
  it("rejects unaffordable, unavailable, and incorrectly scaled products", () => {
    expect(() =>
      applyProposal(sampleRoom, sampleProposal, sampleProducts, {
        ...sampleBrief,
        budgetCents: 100,
      }),
    ).toThrow("budget");
    expect(() =>
      applyProposal(
        sampleRoom,
        sampleProposal,
        [{ ...sampleProducts[0], availability: "unavailable" }],
        sampleBrief,
      ),
    ).toThrow("not available");
    const proposal = proposalSchema.parse({
      ...sampleProposal,
      additions: [
        {
          ...sampleProposal.additions[0],
          dimensions: { width: 0.01, height: 0.01, depth: 0.01 },
        },
      ],
    });
    expect(() =>
      applyProposal(sampleRoom, proposal, sampleProducts, sampleBrief),
    ).toThrow("match the product");
  });
  it("ranks query matches and filters products outside the remaining budget", () => {
    const result = fixtureSearch({
      room: sampleRoom,
      brief: sampleBrief,
      query: "warm lighting",
    });
    expect(result.products[0].id).toBe("arc-lamp");
    expect(
      fixtureSearch({
        room: sampleRoom,
        brief: { ...sampleBrief, budgetCents: 4000 },
        query: "",
      }).products.map((product) => product.id),
    ).toEqual(["leaning-print"]);
  });
});
