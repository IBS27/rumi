import { describe, expect, it } from "bun:test";
import { parseProductJsonLd } from "../shared/search/jsonld";
import {
  isShopify,
  mapShopifyProduct,
  productJsonUrl,
} from "../shared/search/shopify";
import {
  diagramReadTargets,
  relevantImages,
  shortlistDiagramImages,
  slugTokens,
} from "../shared/search/images";
import { domainsFor, tierFor } from "../shared/search/retailers";
import { parseDimensionText } from "../shared/search/dimensions";

const jsonLdHtml = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Oak wardrobe",
 "sku":"WD-63","color":"Natural Oak",
 "image":["https://shop.test/a.jpg","https://shop.test/dimensions.jpg"],
 "offers":{"@type":"Offer","price":"499.00","priceCurrency":"USD",
           "availability":"https://schema.org/InStock"},
 "width":{"@type":"QuantitativeValue","value":63,"unitCode":"INH"},
 "depth":{"@type":"QuantitativeValue","value":18.9,"unitCode":"INH"},
 "height":{"@type":"QuantitativeValue","value":70.9,"unitCode":"INH"}}
</script></head><body></body></html>`;

describe("JSON-LD", () => {
  it("reads price, stock, images and dimensions", () => {
    const product = parseProductJsonLd(jsonLdHtml);
    expect(product?.name).toBe("Oak wardrobe");
    expect(product?.priceCents).toBe(49900);
    expect(product?.availability).toBe("available");
    expect(product?.images).toHaveLength(2);
    expect(product?.color).toBe("Natural Oak");
    const dimensions = parseDimensionText(
      product?.dimensionText ?? "",
      "storage",
    );
    expect(dimensions.values.width).toBeCloseTo(1.6, 2);
    expect(dimensions.values.height).toBeCloseTo(1.801, 2);
  });

  it("finds a product inside an @graph", () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":"Product","name":"Lamp",
       "offers":{"price":79,"priceCurrency":"USD",
                 "availability":"https://schema.org/OutOfStock"}}]}</script>`;
    const product = parseProductJsonLd(html);
    expect(product?.name).toBe("Lamp");
    expect(product?.priceCents).toBe(7900);
    expect(product?.availability).toBe("unavailable");
  });

  it("reads dimensions from additionalProperty entries", () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","name":"Shelf","additionalProperty":[
        {"@type":"PropertyValue","name":"Width","value":"110","unitText":"cm"},
        {"@type":"PropertyValue","name":"Depth","value":"35","unitText":"cm"},
        {"@type":"PropertyValue","name":"Height","value":"70","unitText":"cm"}]}</script>`;
    const product = parseProductJsonLd(html);
    const dimensions = parseDimensionText(
      product?.dimensionText ?? "",
      "storage",
    );
    expect(dimensions.values.width).toBeCloseTo(1.1, 2);
    expect(dimensions.values.depth).toBeCloseTo(0.35, 2);
  });

  it("survives malformed or absent JSON-LD", () => {
    expect(parseProductJsonLd("<html></html>")).toBeNull();
    expect(
      parseProductJsonLd(
        '<script type="application/ld+json">{ not json </script>',
      ),
    ).toBeNull();
  });
});

// Shaped after a real storefront response.
const shopifyPayload = {
  products: [
    {
      id: 9336860737698,
      title: "Bed Frame Expansion Kit",
      handle: "bed-frame-expansion-kit",
      vendor: "RIZE",
      product_type: "Add On/Expansion",
      tags: ["Cherry", "Bedroom"],
      body_html:
        "<p>Solid wood. <b>Width: 63 in</b>, Depth: 18.9 in, Height: 70.9 in</p>",
      images: [
        { src: "https://cdn.shopify.com/a.jpg", alt: "front" },
        { src: "https://cdn.shopify.com/dimensions-chart.jpg", alt: null },
      ],
      variants: [
        {
          id: 1,
          title: "Cherry / White",
          price: "425.00",
          available: true,
          sku: "FB-EXBD-RDWH",
        },
        {
          id: 2,
          title: "Walnut / Black",
          price: "465.50",
          available: false,
          sku: "FB-EXBD-WLBK",
        },
      ],
    },
  ],
};

describe("Shopify", () => {
  it("detects a storefront from page markup", () => {
    expect(isShopify('<script src="https://cdn.shopify.com/s/x.js">')).toBe(
      true,
    );
    expect(isShopify("<html>var Shopify = {};Shopify.shop='x'</html>")).toBe(
      true,
    );
    expect(isShopify("<html>plain</html>")).toBe(false);
  });

  it("derives the product JSON URL from a product page", () => {
    expect(
      productJsonUrl("https://shop.test/products/oak-bed?variant=42"),
    ).toBe("https://shop.test/products/oak-bed.json");
    expect(productJsonUrl("https://shop.test/collections/beds")).toBeNull();
  });

  it("maps merchant price, variants, stock and images", () => {
    const product = mapShopifyProduct(shopifyPayload);
    expect(product?.title).toBe("Bed Frame Expansion Kit");
    expect(product?.variants).toHaveLength(2);
    expect(product?.variants[0].priceCents).toBe(42500);
    expect(product?.variants[1].available).toBe(false);
    expect(product?.images[1].url).toContain("dimensions-chart");
    expect(product?.bodyText).toContain("Width: 63 in");
    expect(product?.bodyText).not.toContain("<b>");
  });

  it("accepts a single product payload and rejects anything else", () => {
    expect(
      mapShopifyProduct({ product: shopifyPayload.products[0] })?.title,
    ).toBe("Bed Frame Expansion Kit");
    expect(mapShopifyProduct({ nope: true })).toBeNull();
    expect(mapShopifyProduct("<html>")).toBeNull();
  });
});

describe("diagram image shortlist", () => {
  it("puts images named like a dimension drawing first", () => {
    const shortlist = shortlistDiagramImages([
      { url: "https://x.test/hero.jpg", alt: "in a room" },
      { url: "https://x.test/detail.jpg", alt: null },
      { url: "https://x.test/product-dimensions.jpg", alt: null },
      { url: "https://x.test/closeup.jpg", alt: "size guide" },
    ]);
    // Both named images come before the unnamed ones.
    expect(
      shortlist.slice(0, 2).map((image) => image.alt ?? image.url),
    ).toEqual(
      expect.arrayContaining([
        "size guide",
        "https://x.test/product-dimensions.jpg",
      ]),
    );
  });

  it("caps the shortlist and keeps gallery order for ties", () => {
    const images = Array.from({ length: 9 }, (_, index) => ({
      url: `https://x.test/${index}.jpg`,
      alt: null,
    }));
    const shortlist = shortlistDiagramImages(images);
    expect(shortlist).toHaveLength(4);
    // Last of the gallery first, then the ones just after the hero shot.
    expect(shortlist[0].url).toContain("8.jpg");
    expect(shortlist[1].url).toContain("1.jpg");
  });

  it("returns nothing for a product without images", () => {
    expect(shortlistDiagramImages([])).toEqual([]);
  });
});

describe("retailer tiers", () => {
  it("chooses a tier from the price ceiling", () => {
    expect(tierFor(5000)).toBe("value");
    expect(tierFor(90000)).toBe("mid");
    expect(tierFor(400000)).toBe("luxury");
  });

  it("returns bare hostnames for the tier", () => {
    const value = domainsFor(5000);
    const mid = domainsFor(90000);
    const luxury = domainsFor(400000);
    expect(value.some((domain) => domain.includes("ikea"))).toBe(true);
    expect(value).toEqual(
      expect.arrayContaining(["walmart.com", "wayfair.com", "target.com"]),
    );
    expect(mid).toEqual(expect.arrayContaining(value));
    expect(mid).toContain("article.com");
    expect(luxury).toEqual(expect.arrayContaining(mid));
    expect(luxury).not.toEqual(value);
    for (const domain of [...value, ...luxury])
      expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });
});

describe("diagram read targets", () => {
  it("reads a single image when one is named like a drawing", () => {
    const targets = diagramReadTargets([
      { url: "https://x.test/hero.jpg", alt: null },
      { url: "https://x.test/dimensions.jpg", alt: null },
      { url: "https://x.test/side.jpg", alt: null },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].url).toContain("dimensions");
  });

  it("shows two candidates when nothing is named", () => {
    const targets = diagramReadTargets([
      { url: "https://x.test/1.jpg", alt: null },
      { url: "https://x.test/2.jpg", alt: null },
      { url: "https://x.test/3.jpg", alt: null },
    ]);
    expect(targets).toHaveLength(2);
  });

  it("asks for nothing when there are no images", () => {
    expect(diagramReadTargets([])).toEqual([]);
  });
});

describe("telling a product gallery from page furniture", () => {
  const chrome = [
    { url: "https://shop.test/cdn/Rectangle_1317_500x.png", alt: null },
    { url: "https://shop.test/cdn/F26-ECOM-MENU-3.png", alt: "menu" },
    { url: "https://shop.test/cdn/oak-wardrobe-front_800x.jpg", alt: null },
    {
      url: "https://shop.test/cdn/unnamed_55406.jpg",
      alt: "Oak Wardrobe dimensions",
    },
  ];

  it("keeps only images that name the product", () => {
    const kept = relevantImages(
      chrome,
      "https://shop.test/products/oak-wardrobe",
    );
    expect(kept.map((image) => image.url)).toEqual([
      "https://shop.test/cdn/oak-wardrobe-front_800x.jpg",
      "https://shop.test/cdn/unnamed_55406.jpg",
    ]);
  });

  it("keeps nothing when the URL carries no usable slug", () => {
    expect(relevantImages(chrome, "https://shop.test/p/4821")).toEqual([]);
    expect(relevantImages(chrome, "not a url")).toEqual([]);
  });

  it("splits a slug into usable tokens", () => {
    expect(slugTokens("https://shop.test/products/low-oak-cabinet")).toEqual([
      "low",
      "oak",
      "cabinet",
    ]);
  });
});

describe("thumbnails", () => {
  it("never shortlists an image too small to read", () => {
    const shortlist = shortlistDiagramImages([
      { url: "https://x.test/a?wid=100&hei=100&fmt=pjpeg", alt: null },
      { url: "https://x.test/b_150x.jpg", alt: null },
      { url: "https://x.test/c.jpg?w=320&fit=max", alt: null },
      { url: "https://x.test/d.jpg?fit=max&w=1200", alt: null },
    ]);
    expect(shortlist.map((image) => image.url)).toEqual([
      "https://x.test/d.jpg?fit=max&w=1200",
    ]);
  });
});
