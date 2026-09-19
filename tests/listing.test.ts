import { describe, expect, it } from "bun:test";
import {
  chooseVariant,
  factsFromJsonLd,
  factsFromShopify,
} from "../shared/search/listing";
import type { ShopifyProduct } from "../shared/search/shopify";

const shopify: ShopifyProduct = {
  title: "Four door wardrobe",
  handle: "four-door-wardrobe",
  vendor: "Studio",
  productType: "Wardrobe",
  tags: ["bedroom"],
  bodyText: "Width: 63 in, Depth: 18.9 in, Height: 70.9 in",
  images: [
    { url: "https://cdn.shopify.com/hero.jpg", alt: "front" },
    { url: "https://cdn.shopify.com/dimensions.jpg", alt: null },
  ],
  variants: [
    {
      id: "1",
      title: "Navy",
      priceCents: 42000,
      available: true,
      sku: "A",
    },
    {
      id: "2",
      title: "Natural Oak",
      priceCents: 45000,
      available: true,
      sku: "B",
    },
    {
      id: "3",
      title: "Walnut",
      priceCents: 99000,
      available: true,
      sku: "C",
    },
  ],
};

const choice = { maxPriceCents: 50000, palette: ["#c9a878"] };

describe("choosing a variant", () => {
  it("prefers the in-budget finish closest to the palette", () => {
    expect(chooseVariant(shopify, choice)?.title).toBe("Natural Oak");
  });

  it("ignores a closer finish that is over the ceiling", () => {
    expect(
      chooseVariant(shopify, { maxPriceCents: 43000, palette: ["#5c4033"] })
        ?.title,
    ).toBe("Navy");
  });

  it("falls back to an out-of-budget variant rather than nothing", () => {
    const variant = chooseVariant(shopify, {
      maxPriceCents: 1000,
      palette: [],
    });
    expect(variant).not.toBeNull();
  });

  it("prefers a variant that is in stock", () => {
    const stock: ShopifyProduct = {
      ...shopify,
      variants: [
        { ...shopify.variants[1], available: false },
        { ...shopify.variants[0], available: true },
      ],
    };
    expect(chooseVariant(stock, choice)?.title).toBe("Navy");
  });

  it("handles a product with no variants", () => {
    expect(chooseVariant({ ...shopify, variants: [] }, choice)).toBeNull();
  });
});

describe("merchant facts", () => {
  it("takes price, stock, images and body text from the storefront", () => {
    const { facts, images, bodyText } = factsFromShopify(shopify, choice);
    expect(facts.priceCents).toBe(45000);
    expect(facts.availability).toBe("available");
    expect(facts.tags).toContain("Wardrobe");
    expect(images).toHaveLength(2);
    expect(bodyText).toContain("63 in");
  });

  it("returns nothing usable for a page that is not a storefront", () => {
    expect(factsFromShopify(null, choice).facts).toEqual({});
  });

  it("maps structured data from JSON-LD", () => {
    const facts = factsFromJsonLd({
      name: "Oak wardrobe",
      priceCents: 49900,
      currency: "USD",
      availability: "available",
      images: ["https://shop.test/a.jpg"],
      sku: "WD-63",
      color: "Natural Oak",
      dimensionText: "width: 63 in",
    });
    expect(facts.priceCents).toBe(49900);
    expect(facts.variant).toBe("WD-63");
    expect(facts.imageUrl).toBe("https://shop.test/a.jpg");
  });

  it("returns nothing when a page has no structured data", () => {
    expect(factsFromJsonLd(null)).toEqual({});
  });
});
