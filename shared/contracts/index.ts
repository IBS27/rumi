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
// Where a measurement came from. "structured" is machine-readable merchant data,
// "spec-text" a printed specification, "image" a dimension diagram, "mixed" a text
// reading completed by a diagram.
export const evidenceSchema = z.object({
  kind: z.enum(["structured", "spec-text", "image", "mixed", "none"]),
  detail: z.string().nullable(),
});
export const measurementSchema = z
  .object({
    dimensions: dimensionsSchema.nullable(),
    source: z.enum(["confirmed", "estimated", "unknown"]),
    evidence: evidenceSchema,
  })
  .refine(
    (value) => (value.dimensions === null) === (value.source === "unknown"),
    "Unknown measurements must have null dimensions",
  )
  .refine(
    (value) => (value.dimensions === null) === (value.evidence.kind === "none"),
    "Measurements without dimensions must have no evidence",
  );
export const categorySchema = z.enum([
  "bed",
  "desk",
  "lighting",
  "rug",
  "storage",
  "art",
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
export const roomSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    revision: z.number().int().nonnegative(),
    shape: z.literal("rectangle"),
    dimensions: dimensionsSchema,
    measurementSource: z.enum(["confirmed", "estimated"]),
    openings: z.array(openingSchema),
    objects: z.array(roomObjectSchema),
  })
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
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const searchTaskSchema = z.object({
  query: z.string(),
  category: categorySchema,
  maxPriceCents: z.number().int().nonnegative(),
  maxFootprint: footprintSchema.nullable(),
  maxHeight: z.number().positive().nullable(),
  styleTerms: z.array(z.string()),
  palette: z.array(hexColorSchema),
  excludeTags: z.array(z.string()),
});
export const searchFailureSchema = z.object({
  stage: z.enum(["search", "extract", "dimensions", "filter"]),
  detail: z.string(),
});
export const scoreBreakdownSchema = z.object({
  fit: z.number().min(0).max(1),
  style: z.number().min(0).max(1),
  color: z.number().min(0).max(1),
  price: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
});
export const rankedCandidateSchema = z.object({
  product: productSchema,
  score: z.number().min(0).max(1),
  breakdown: scoreBreakdownSchema,
});
export const searchTaskResultSchema = z.object({
  category: categorySchema,
  query: z.string(),
  candidates: z.array(rankedCandidateSchema),
  explanation: z.string(),
  failures: z.array(searchFailureSchema),
});
export type Category = z.infer<typeof categorySchema>;
export type RoomSnapshot = z.infer<typeof roomSchema>;
export type RoomObject = z.infer<typeof roomObjectSchema>;
export type ProductCandidate = z.infer<typeof productSchema>;
export type DesignBrief = z.infer<typeof briefSchema>;
export type DesignProposal = z.infer<typeof proposalSchema>;
export type AssetRecord = z.infer<typeof assetSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchTask = z.infer<typeof searchTaskSchema>;
export type SearchFailure = z.infer<typeof searchFailureSchema>;
export type SearchTaskResult = z.infer<typeof searchTaskResultSchema>;
export type MeasurementEvidence = z.infer<typeof evidenceSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type Footprint = z.infer<typeof footprintSchema>;
export type Dimensions = z.infer<typeof dimensionsSchema>;
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;
export type RankedCandidate = z.infer<typeof rankedCandidateSchema>;
