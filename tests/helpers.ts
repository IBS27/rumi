import {
  productSchema,
  searchTaskSchema,
  type ProductCandidate,
  type SearchTask,
} from "../shared/contracts";

export function makeProduct(
  overrides: Partial<ProductCandidate> = {},
): ProductCandidate {
  return productSchema.parse({
    id: "web-00000001",
    variantId: "natural-oak",
    name: "Low oak cabinet",
    category: "storage",
    merchant: "example.com",
    sourceUrl: "https://example.com/products/oak-cabinet",
    imageUrl: "https://example.com/oak.jpg",
    images: ["https://example.com/oak.jpg"],
    priceCents: 24900,
    currency: "USD",
    measurement: {
      dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
      source: "estimated",
      evidence: { kind: "spec-text", detail: '43"W x 14"D x 28"H' },
    },
    color: "#c19a6b",
    tags: ["minimalist", "oak"],
    availability: "available",
    assetId: null,
    synthetic: false,
    ...overrides,
  });
}

export function makeTask(overrides: Partial<SearchTask> = {}): SearchTask {
  return searchTaskSchema.parse({
    query: "oak cabinet",
    category: "storage",
    maxPriceCents: 40000,
    maxFootprint: { width: 1.3, depth: 0.5 },
    maxHeight: 2.2,
    styleTerms: ["minimalist", "natural"],
    palette: ["#c19a6b", "#d8cdb9"],
    miscellaneous: [],
    excludeTags: [],
    ...overrides,
  });
}
