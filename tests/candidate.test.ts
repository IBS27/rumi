import { describe, expect, it } from "bun:test";
import {
  buildCandidate,
  pickFacts,
  resolveColor,
  UNKNOWN_COLOR,
  type ListingFacts,
} from "../shared/search/candidate";
import type { Measurement } from "../shared/contracts";

const measured: Measurement = {
  dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
  source: "estimated",
  evidence: { kind: "structured", detail: "width: 110 cm" },
};

const unknown: Measurement = {
  dimensions: null,
  source: "unknown",
  evidence: { kind: "none", detail: null },
};

const facts = (overrides: Partial<ListingFacts> = {}): ListingFacts =>
  pickFacts([
    {
      name: "Low oak cabinet",
      variant: "Natural Oak",
      priceCents: 24900,
      availability: "available",
      tags: ["Storage", "storage", " Oak "],
      imageUrl: "https://shop.test/a.jpg",
      ...overrides,
    },
  ]);

describe("layering what a listing says", () => {
  it("prefers merchant data over a model reading", () => {
    const merged = pickFacts([
      { priceCents: 42500, availability: "available", variant: "Cherry" },
      { priceCents: 39900, availability: "unknown", name: "Wardrobe" },
    ]);
    expect(merged.priceCents).toBe(42500);
    expect(merged.variant).toBe("Cherry");
    expect(merged.name).toBe("Wardrobe");
  });

  it("falls through to the model when the merchant is silent", () => {
    const merged = pickFacts([{ name: null }, { priceCents: 1999 }]);
    expect(merged.priceCents).toBe(1999);
  });

  it("merges tags without repeats or stray case", () => {
    expect(facts().tags).toEqual(["storage", "oak"]);
  });

  it("keeps availability unknown until something states it", () => {
    expect(pickFacts([{}, {}]).availability).toBe("unknown");
    expect(
      pickFacts([{ availability: "unknown" }, { availability: "unavailable" }])
        .availability,
    ).toBe("unavailable");
  });
});

describe("color", () => {
  it("uses a published hex when there is one", () => {
    expect(resolveColor(facts({ colorHex: "#123456" }))).toBe("#123456");
  });

  it("reads the finish name from the variant", () => {
    expect(resolveColor(facts())).not.toBe(UNKNOWN_COLOR);
    expect(resolveColor(facts({ variant: "Brushed Brass" }))).toBe("#b5952f");
  });

  it("stays neutral rather than inventing a color", () => {
    expect(
      resolveColor(facts({ variant: "Model 27", name: "Cabinet", colorText: null })),
    ).toBe(UNKNOWN_COLOR);
  });

  it("ignores a malformed hex", () => {
    expect(resolveColor(facts({ colorHex: "reddish" }))).not.toBe("reddish");
  });
});

describe("building a candidate", () => {
  it("produces a valid product", () => {
    const { product } = buildCandidate({
      sourceUrl: "https://shop.test/products/oak-cabinet",
      category: "storage",
      facts: facts(),
      measurement: measured,
    });
    expect(product?.merchant).toBe("shop.test");
    expect(product?.priceCents).toBe(24900);
    expect(product?.synthetic).toBe(false);
    expect(product?.measurement.evidence.kind).toBe("structured");
  });

  it("keeps a product whose dimensions are still unknown", () => {
    const { product } = buildCandidate({
      sourceUrl: "https://shop.test/products/oak-cabinet",
      category: "storage",
      facts: facts(),
      measurement: unknown,
    });
    expect(product?.measurement.source).toBe("unknown");
  });

  it("refuses a listing with no price", () => {
    const result = buildCandidate({
      sourceUrl: "https://shop.test/products/oak-cabinet",
      category: "storage",
      facts: facts({ priceCents: null }),
      measurement: measured,
    });
    expect(result.product).toBeNull();
    expect(result.issue).toContain("price");
  });

  it("refuses a listing with no usable source URL", () => {
    expect(
      buildCandidate({
        sourceUrl: "not-a-url",
        category: "storage",
        facts: facts(),
        measurement: measured,
      }).product,
    ).toBeNull();
  });

  it("gives the same product the same id, and different variants different ids", () => {
    const build = (variant: string) =>
      buildCandidate({
        sourceUrl: "https://shop.test/products/oak-cabinet",
        category: "storage",
        facts: facts({ variant }),
        measurement: measured,
      }).product?.id;
    expect(build("Oak")).toBe(build("Oak"));
    expect(build("Oak")).not.toBe(build("Walnut"));
  });
});
