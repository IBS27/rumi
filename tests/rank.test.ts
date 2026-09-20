import { describe, expect, it } from "bun:test";
import {
  dedupeListings,
  diversifyMerchants,
  rankCandidates,
  scoreCandidate,
} from "../shared/search/rank";
import { rankedCandidateSchema } from "../shared/contracts";
import { makeProduct, makeTask } from "./helpers";

const unknownDimensions = {
  dimensions: null,
  source: "unknown",
  evidence: { kind: "none", detail: null },
} as const;

describe("scoring", () => {
  it("produces a valid breakdown and a score inside the unit range", () => {
    const candidate = scoreCandidate(makeProduct(), makeTask());
    expect(() => rankedCandidateSchema.parse(candidate)).not.toThrow();
    expect(candidate.score).toBeGreaterThan(0);
    expect(candidate.score).toBeLessThanOrEqual(1);
  });

  it("prefers a piece that uses the available space", () => {
    const task = makeTask({ maxFootprint: { width: 1.6, depth: 0.6 } });
    const generous = scoreCandidate(
      makeProduct({
        measurement: {
          dimensions: { width: 1.5, height: 0.7, depth: 0.45 },
          source: "estimated",
          evidence: { kind: "spec-text", detail: "spec" },
        },
      }),
      task,
    );
    const tiny = scoreCandidate(
      makeProduct({
        measurement: {
          dimensions: { width: 0.4, height: 0.7, depth: 0.3 },
          source: "estimated",
          evidence: { kind: "spec-text", detail: "spec" },
        },
      }),
      task,
    );
    expect(generous.breakdown.fit).toBeGreaterThan(tiny.breakdown.fit);
  });

  it("rewards style words and palette proximity", () => {
    const task = makeTask();
    const onBrief = scoreCandidate(makeProduct(), task);
    const offBrief = scoreCandidate(
      makeProduct({
        name: "Ornate carved cabinet",
        tags: ["baroque"],
        color: "#1c3f8a",
      }),
      task,
    );
    expect(onBrief.breakdown.style).toBeGreaterThan(offBrief.breakdown.style);
    expect(onBrief.breakdown.color).toBeGreaterThan(offBrief.breakdown.color);
  });

  it("penalises a price far below the ceiling as an accessory", () => {
    const task = makeTask({ maxPriceCents: 40000 });
    const sensible = scoreCandidate(makeProduct({ priceCents: 24900 }), task);
    const suspicious = scoreCandidate(makeProduct({ priceCents: 1200 }), task);
    expect(suspicious.breakdown.price).toBeLessThan(sensible.breakdown.price);
  });

  it("scores known dimensions as more complete than unknown ones", () => {
    const task = makeTask();
    const known = scoreCandidate(makeProduct(), task);
    const unknown = scoreCandidate(
      makeProduct({ measurement: unknownDimensions }),
      task,
    );
    expect(known.breakdown.completeness).toBeGreaterThan(
      unknown.breakdown.completeness,
    );
  });
});

describe("dedupe", () => {
  it("keeps one listing when the same product appears at three merchants", () => {
    const listings = [
      makeProduct({ id: "a", merchant: "one.com", priceCents: 24900 }),
      makeProduct({
        id: "b",
        merchant: "two.com",
        priceCents: 25400,
        name: "Low Oak Cabinet",
        sourceUrl: "https://two.com/p/oak",
      }),
      makeProduct({
        id: "c",
        merchant: "three.com",
        priceCents: 24900,
        name: "low oak cabinet!",
        sourceUrl: "https://three.com/p/oak",
      }),
    ];
    expect(dedupeListings(listings)).toHaveLength(1);
  });

  it("keeps genuinely different products", () => {
    const listings = [
      makeProduct({ id: "a" }),
      makeProduct({
        id: "b",
        name: "Tall walnut wardrobe",
        sourceUrl: "https://example.com/p/wardrobe",
      }),
    ];
    expect(dedupeListings(listings)).toHaveLength(2);
  });

  it("keeps the same name at a very different price", () => {
    const listings = [
      makeProduct({ id: "a", priceCents: 24900 }),
      makeProduct({
        id: "b",
        priceCents: 39900,
        sourceUrl: "https://example.com/p/other",
      }),
    ];
    expect(dedupeListings(listings)).toHaveLength(2);
  });
});

describe("ranking", () => {
  it("orders by score and puts unknown dimensions last", () => {
    const task = makeTask();
    const ranked = rankCandidates(
      [
        makeProduct({
          id: "unknown",
          name: "Mystery cabinet",
          measurement: unknownDimensions,
          sourceUrl: "https://example.com/p/mystery",
        }),
        makeProduct({ id: "good" }),
        makeProduct({
          id: "plain",
          name: "Ornate carved cabinet",
          tags: ["baroque"],
          color: "#1c3f8a",
          sourceUrl: "https://example.com/p/ornate",
        }),
      ],
      task,
    );
    expect(ranked.map((item) => item.product.id)).toEqual([
      "good",
      "plain",
      "unknown",
    ]);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it("puts different merchants in the first result slots", () => {
    const task = makeTask();
    const ranked = rankCandidates(
      [
        makeProduct({ id: "target-1", merchant: "target.com" }),
        makeProduct({
          id: "target-2",
          merchant: "target.com",
          name: "Wide oak cabinet",
          sourceUrl: "https://target.com/p/2",
        }),
        makeProduct({
          id: "walmart",
          merchant: "walmart.com",
          name: "Oak sideboard cabinet",
          sourceUrl: "https://walmart.com/ip/1",
        }),
        makeProduct({
          id: "ikea",
          merchant: "ikea.com",
          name: "Oak door cabinet",
          sourceUrl: "https://ikea.com/p/1",
        }),
      ],
      task,
    );
    const diversified = diversifyMerchants(ranked, 3);
    expect(
      new Set(diversified.slice(0, 3).map((item) => item.product.merchant))
        .size,
    ).toBe(3);
  });
});
