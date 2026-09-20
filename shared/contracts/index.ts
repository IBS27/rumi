import { z } from "zod";

export const idSchema = z.string().min(1);
export const vectorSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export const dimensionsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
});
export const measurementSchema = z
  .object({
    dimensions: dimensionsSchema.nullable(),
    source: z.enum(["confirmed", "estimated", "unknown"]),
  })
  .refine(
    (value) => (value.dimensions === null) === (value.source === "unknown"),
    "Unknown measurements must have null dimensions",
  );
export const categorySchema = z.enum([
  "bed",
  "desk",
  "lighting",
  "rug",
  "storage",
  "art",
  "sofa",
  "chair",
  "table",
  "refrigerator",
  "oven",
  "sink",
  "toilet",
  "bathtub",
  "dishwasher",
  "washerDryer",
  "television",
  "fireplace",
  "stairs",
  "unknown",
]);
export const assetSchema = z
  .object({
    id: idSchema,
    status: z.enum(["placeholder", "pending", "ready", "failed"]),
    url: z.url().nullable(),
    accuracy: z.enum(["approximate", "manufacturer"]),
    scale: z.number().positive(),
    rotation: vectorSchema,
  })
  .refine(
    (value) => value.status !== "ready" || value.url !== null,
    "Ready assets require a URL",
  );
export const productSchema = z.object({
  id: idSchema,
  variantId: idSchema,
  name: z.string().min(1),
  category: categorySchema,
  merchant: z.string(),
  sourceUrl: z.url(),
  imageUrl: z.url().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  measurement: measurementSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  tags: z.array(z.string()),
  availability: z.enum(["available", "unavailable", "unknown"]),
  assetId: idSchema.nullable(),
  synthetic: z.boolean(),
});
export const roomObjectSchema = z.object({
  id: idSchema,
  name: z.string(),
  category: categorySchema,
  productId: idSchema.nullable(),
  assetId: idSchema.nullable(),
  dimensions: dimensionsSchema,
  position: vectorSchema,
  rotation: vectorSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  owned: z.boolean(),
  locked: z.boolean(),
  measurementSource: z.enum(["confirmed", "estimated"]).optional(),
  detectionConfidence: z.enum(["high", "medium", "low", "unknown"]).optional(),
  sourceCategory: z.string().optional(),
});
export const capturedSurfaceSchema = z.object({
  id: idSchema,
  kind: z.enum(["wall", "floor", "door", "window", "opening"]),
  parentId: idSchema.nullable(),
  dimensions: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    depth: z.number().nonnegative(),
  }),
  // Column-major local-to-room affine transform, retaining the scan orientation.
  transform: z.array(z.number().finite()).length(16),
  polygonCorners: z.array(vectorSchema).max(512),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
});
export const openingSchema = z.object({
  id: idSchema,
  kind: z.enum(["door", "window"]),
  wall: z.enum(["north", "east", "south", "west"]),
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().nonnegative(),
});
const roomFields = {
  id: idSchema,
  name: z.string(),
  revision: z.number().int().nonnegative(),
  dimensions: dimensionsSchema,
  measurementSource: z.enum(["confirmed", "estimated"]),
  objects: z.array(roomObjectSchema),
};
export const roomSchema = z
  .discriminatedUnion("shape", [
    z.object({
      ...roomFields,
      shape: z.literal("rectangle"),
      openings: z.array(openingSchema),
    }),
    z.object({
      ...roomFields,
      shape: z.literal("polygon"),
      walls: z.array(capturedSurfaceSchema).min(1).max(200),
      floors: z.array(capturedSurfaceSchema).max(30),
      openings: z.array(capturedSurfaceSchema).max(200),
      capture: z.object({
        provider: z.literal("roomplan"),
        version: z.number().nullable(),
        synthetic: z.boolean(),
        origin: vectorSchema,
        warnings: z.array(z.string()),
      }),
    }),
  ])
  .refine(
    (room) =>
      new Set(room.objects.map((object) => object.id)).size ===
      room.objects.length,
    "Object IDs must be unique",
  );
export const briefSchema = z.object({
  prompt: z.string(),
  styles: z.array(z.string()),
  budgetCents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  restrictions: z.array(z.string()),
});
export const proposalSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  baseRevision: z.number().int().nonnegative(),
  summary: z.string(),
  additions: z.array(roomObjectSchema),
});
export const searchRequestSchema = z.object({
  room: roomSchema,
  brief: briefSchema,
  query: z.string(),
});
export const searchResultSchema = z.object({
  products: z.array(productSchema),
  explanation: z.string(),
});
export const footprintSchema = z.object({
  width: z.number().positive(),
  depth: z.number().positive(),
});
export const searchTaskSchema = z.object({
  query: z.string(),
  category: categorySchema,
  maxPriceCents: z.number().int().nonnegative(),
  maxFootprint: footprintSchema.nullable(),
  styleTerms: z.array(z.string()),
  excludeTags: z.array(z.string()),
});
export const searchFailureSchema = z.object({
  stage: z.enum(["search", "extract", "filter"]),
  detail: z.string(),
});
export const searchTaskResultSchema = searchResultSchema.extend({
  failures: z.array(searchFailureSchema),
});
export type RoomSnapshot = z.infer<typeof roomSchema>;
export type RoomObject = z.infer<typeof roomObjectSchema>;
export type CapturedSurface = z.infer<typeof capturedSurfaceSchema>;
export type CapturedRoom = Extract<RoomSnapshot, { shape: "polygon" }>;
export type ProductCandidate = z.infer<typeof productSchema>;
export type DesignBrief = z.infer<typeof briefSchema>;
export type DesignProposal = z.infer<typeof proposalSchema>;
export type AssetRecord = z.infer<typeof assetSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchTask = z.infer<typeof searchTaskSchema>;
export type SearchFailure = z.infer<typeof searchFailureSchema>;
export type SearchTaskResult = z.infer<typeof searchTaskResultSchema>;
