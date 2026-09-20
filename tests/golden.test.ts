import { describe, expect, it } from "bun:test";
import ikea from "./fixtures/ikea-billy.json";
import theBlock from "./fixtures/shopify-the-block.json";
import {
  completeDimensions,
  parseDimensionText,
} from "../shared/search/dimensions";
import { mapShopifyProduct } from "../shared/search/shopify";
import { factsFromShopify } from "../shared/search/listing";
import { buildCandidate, pickFacts } from "../shared/search/candidate";
import { shortlistDiagramImages } from "../shared/search/images";

// Snapshots of real retailer pages. They record what the web actually looks like,
// including the parts that do not work yet, so a change of behaviour is visible.

describe("a live IKEA listing", () => {
  it("refuses the unordered triple its static markup prints", () => {
    // "31 1/2x11x41 3/4" states no axis order, so no reading is safe. The page's
    // labelled specification is rendered in the browser and is not in this markup;
    // rendered content or the dimension drawing has to supply it.
    const reading = parseDimensionText(ikea.text, "storage");
    expect(completeDimensions(reading.values)).toBeNull();
    expect(reading.issue).toContain("order");
  });

  it("does not mistake the price for a measurement", () => {
    const reading = parseDimensionText(ikea.text, "storage");
    expect(reading.values.width).toBeNull();
  });

  it("publishes no product structured data to fall back on", () => {
    expect(ikea.hasProductJsonLd).toBe(false);
  });
});

describe("a live Shopify listing", () => {
  const mapped = mapShopifyProduct(theBlock);

  it("maps the merchant's own price, variants and stock", () => {
    expect(mapped?.title).toBe("The Block");
    expect(mapped?.variants.length).toBeGreaterThan(0);
    for (const variant of mapped?.variants ?? []) {
      expect(Number.isInteger(variant.priceCents)).toBe(true);
      expect(variant.priceCents).toBeGreaterThan(0);
    }
  });

  it("builds a real candidate with no model call at all", () => {
    const { facts, bodyText } = factsFromShopify(mapped, {
      maxPriceCents: 120000,
      palette: ["#1a1a1a"],
    });
    const { product } = buildCandidate({
      sourceUrl: theBlock.url,
      category: "storage",
      facts: pickFacts([facts]),
      // This storefront states no size, so the candidate is honest about it.
      measurement: {
        dimensions: completeDimensions(
          parseDimensionText(bodyText, "storage").values,
        ),
        source: "unknown",
        evidence: { kind: "none", detail: null },
      },
    });
    expect(product?.merchant).toBe("floydhome.com");
    expect(product?.priceCents).toBeGreaterThan(0);
    expect(product?.availability).not.toBe("unknown");
  });

  it("states no dimensions, which is why the drawing stage exists", () => {
    const { bodyText } = factsFromShopify(mapped, {
      maxPriceCents: 120000,
      palette: [],
    });
    expect(
      completeDimensions(parseDimensionText(bodyText, "storage").values),
    ).toBeNull();
  });

  it("offers product images the diagram shortlist can rank", () => {
    const images = mapped?.images ?? [];
    expect(images.length).toBeGreaterThan(0);
    expect(shortlistDiagramImages(images).length).toBeGreaterThan(0);
  });
});
