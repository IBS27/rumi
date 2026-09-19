import {
  assetSchema,
  briefSchema,
  productSchema,
  proposalSchema,
  roomSchema,
} from "../contracts";

export const sampleRoom = roomSchema.parse({
  id: "bedroom-demo",
  name: "A quieter kind of bedroom",
  revision: 0,
  shape: "rectangle",
  dimensions: { width: 4.8, height: 2.7, depth: 4.2 },
  measurementSource: "confirmed",
  openings: [
    {
      id: "door",
      kind: "door",
      wall: "south",
      offset: 0.25,
      width: 0.9,
      height: 2.1,
      sill: 0,
    },
    {
      id: "window",
      kind: "window",
      wall: "north",
      offset: 2.7,
      width: 1.4,
      height: 1.2,
      sill: 1,
    },
  ],
  objects: [
    {
      id: "owned-bed",
      name: "Your bed",
      category: "bed",
      productId: null,
      assetId: null,
      dimensions: { width: 1.6, height: 0.6, depth: 2.1 },
      position: { x: 1.15, y: 0, z: 1.45 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#d8cdb9",
      owned: true,
      locked: true,
    },
    {
      id: "owned-desk",
      name: "Your desk",
      category: "desk",
      productId: null,
      assetId: null,
      dimensions: { width: 1.2, height: 0.75, depth: 0.6 },
      position: { x: 3.7, y: 0, z: 0.55 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#997659",
      owned: true,
      locked: true,
    },
  ],
});
export const sampleBrief = briefSchema.parse({
  prompt:
    "A modern minimalist bedroom with warm lighting and wall decorations.",
  styles: ["minimalist", "warm", "natural"],
  budgetCents: 50000,
  currency: "USD",
  restrictions: ["Keep existing bed and desk", "No drilling"],
});
const catalog = [
  {
    id: "arc-lamp",
    name: "Arc floor lamp",
    category: "lighting",
    priceCents: 7900,
    dimensions: { width: 0.45, height: 1.55, depth: 0.45 },
    color: "#c49b60",
    tags: ["warm", "minimalist", "lighting"],
  },
  {
    id: "woven-rug",
    name: "Woven wool rug",
    category: "rug",
    priceCents: 12900,
    dimensions: { width: 1.6, height: 0.02, depth: 2.2 },
    color: "#b6b19b",
    tags: ["natural", "warm", "minimalist"],
  },
  {
    id: "oak-shelf",
    name: "Low oak cabinet",
    category: "storage",
    priceCents: 14900,
    dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
    color: "#b78d60",
    tags: ["natural", "minimalist", "storage"],
  },
  {
    id: "leaning-print",
    name: "Quiet forms print",
    category: "art",
    priceCents: 3900,
    dimensions: { width: 0.5, height: 0.7, depth: 0.05 },
    color: "#768574",
    tags: ["art", "warm", "no drilling"],
  },
] as const;
export const sampleProducts = catalog.map((item) =>
  productSchema.parse({
    ...item,
    variantId: `${item.id}-natural`,
    merchant: "Studio sample catalog",
    sourceUrl: `https://example.com/products/${item.id}`,
    imageUrl: null,
    currency: "USD",
    measurement: { dimensions: item.dimensions, source: "confirmed" },
    availability: "available",
    assetId: `${item.id}-asset`,
    synthetic: true,
  }),
);
export const sampleAssets = sampleProducts.map((product) =>
  assetSchema.parse({
    id: product.assetId,
    status: "placeholder",
    url: null,
    accuracy: "approximate",
    scale: 1,
    rotation: { x: 0, y: 0, z: 0 },
  }),
);
export const sampleProposal = proposalSchema.parse({
  id: "sample-proposal",
  roomId: sampleRoom.id,
  baseRevision: 0,
  summary: "Warm lighting beside your existing bed.",
  additions: [
    {
      id: "placed-arc-lamp",
      name: sampleProducts[0].name,
      category: "lighting",
      productId: "arc-lamp",
      assetId: "arc-lamp-asset",
      dimensions: sampleProducts[0].measurement.dimensions,
      position: { x: 2.35, y: 0, z: 0.65 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#c49b60",
      owned: false,
      locked: false,
    },
  ],
});
export const edgeCaseProducts = {
  oversized: productSchema.parse({
    ...sampleProducts[2],
    id: "oversized",
    measurement: {
      dimensions: { width: 6, height: 1, depth: 1 },
      source: "confirmed",
    },
  }),
  unknownDimensions: productSchema.parse({
    ...sampleProducts[0],
    id: "unknown",
    measurement: { dimensions: null, source: "unknown" },
  }),
  overBudget: productSchema.parse({
    ...sampleProducts[0],
    id: "expensive",
    priceCents: 60000,
  }),
  unavailable: productSchema.parse({
    ...sampleProducts[0],
    id: "sold-out",
    availability: "unavailable",
  }),
};
