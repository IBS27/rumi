import { z } from "zod";
import { parametricModelSchema } from "../assets/model";

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
// Product search accepts concrete item labels without widening captured room objects.
export const searchCategorySchema = z.string().trim().min(1).max(80);
export const assetSchema = z
  .object({
    id: idSchema,
    status: z.enum(["placeholder", "pending", "ready", "failed"]),
    url: z.url().nullable(),
    accuracy: z.enum(["approximate", "manufacturer"]),
    scale: z.number().positive(),
    rotation: vectorSchema,
    // Parametric scenes are generated from product photos and rendered directly by
    // Three.js. Existing GLB/manufacturer assets continue to use url.
    scene: parametricModelSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== "ready" || value.url !== null || value.scene != null,
    "Ready assets require a URL or parametric scene",
  );
export const productSchema = z.object({
  id: idSchema,
  variantId: idSchema,
  name: z.string().min(1),
  category: searchCategorySchema,
  merchant: z.string(),
  sourceUrl: z.url(),
  imageUrl: z.url().nullable(),
  // The gallery, best first. imageUrl is its first entry, kept for product cards.
  images: z.array(z.url()).max(8),
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
// The workflow has two stages. Spec gathers the brief; Plan reserves space and
// searches. Review is reached once every zone has a product.
export const projectPhaseSchema = z.enum(["spec", "plan", "review"]);
// An item the user asked for, before any space is reserved for it.
export const wantSchema = z.object({
  category: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(200),
});
export const briefSchema = z.object({
  prompt: z.string(),
  styles: z.array(z.string()),
  budgetCents: z.number().int().nonnegative(),
  currency: z.literal("USD"),
  restrictions: z.array(z.string()),
  // Filled in during Spec. Older briefs lack these, so they default.
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).default([]),
  materials: z.array(z.string()).max(12).default([]),
  wants: z.array(wantSchema).max(12).default([]),
  // A merged summary of inspiration-image analyses, in the agent's words.
  inspiration: z.string().max(1200).default(""),
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
  query: z.string().trim().min(1).max(200),
  category: searchCategorySchema,
  maxPriceCents: z
    .number()
    .int()
    .nonnegative()
    .describe("Maximum price in cents. Use 0 when the user gave no budget."),
  maxFootprint: footprintSchema.nullable(),
  maxHeight: z.number().positive().nullable(),
  styleTerms: z.array(z.string()),
  palette: z.array(hexColorSchema),
  miscellaneous: z.array(z.string().trim().min(1).max(160)).max(12),
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
  category: searchCategorySchema,
  query: z.string(),
  candidates: z.array(rankedCandidateSchema),
  explanation: z.string(),
  failures: z.array(searchFailureSchema),
});
// Planner contracts. The model proposes what a room needs; code owns every meter.
export const zoneAnchorSchema = z.enum([
  "wall",
  "corner",
  "center",
  "window",
  "near-object",
  "anywhere",
]);
// Model output is clipped, not rejected, on length: a verbose sentence must not
// discard an otherwise sound plan.
const clipped = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .pipe(z.string().min(1));
// Where a piece lives: on the floor, hung on a wall, on top of another piece
// (a table lamp on a desk), or under other pieces (a rug).
export const zoneMountSchema = z.enum(["floor", "wall", "surface", "under"]);
export const zoneRequestSchema = z.object({
  id: idSchema,
  purpose: clipped(120),
  category: clipped(80),
  query: clipped(200),
  mount: zoneMountSchema,
  anchor: zoneAnchorSchema,
  // For surface mounts: the existing object or earlier zone the piece sits on.
  relatedObjectId: z.string().nullable(),
  // Desired footprint in meters. Code shrinks it to what actually fits. A
  // model may write 0 for a print's thickness; clamp rather than reject.
  desiredFootprint: z
    .object({ width: z.number(), depth: z.number() })
    .transform((value) => ({
      width: Math.max(0.02, value.width),
      depth: Math.max(0.02, value.depth),
    }))
    .pipe(footprintSchema),
  desiredHeight: z
    .number()
    .nullable()
    .transform((value) => (value !== null && value > 0 ? value : null)),
  miscellaneous: z
    .array(z.string())
    .transform((items) =>
      items
        .map((item) => item.trim().slice(0, 160))
        .filter((item) => item.length > 0)
        .slice(0, 12),
    ),
  priority: z.number().int().positive(),
});
export const zonePlanRequestSchema = z.object({
  summary: clipped(600),
  zones: z.array(zoneRequestSchema).min(1).max(6),
});
// The same shape with no transforms or bounds, for structured model output.
// The model fills this; zonePlanRequestSchema then clips and validates it.
export const zonePlanWireSchema = z.object({
  summary: z.string(),
  zones: z.array(
    z.object({
      id: z.string(),
      purpose: z.string(),
      category: z.string(),
      query: z.string(),
      mount: zoneMountSchema,
      anchor: zoneAnchorSchema,
      relatedObjectId: z.string().nullable(),
      desiredFootprint: z.object({ width: z.number(), depth: z.number() }),
      desiredHeight: z.number().nullable(),
      miscellaneous: z.array(z.string()),
      priority: z.number(),
    }),
  ),
});
export const reservedZoneSchema = z.object({
  id: idSchema,
  purpose: z.string(),
  category: searchCategorySchema,
  query: z.string(),
  mount: zoneMountSchema,
  anchor: zoneAnchorSchema,
  relatedObjectId: idSchema.nullable(),
  // Base-center position and yaw, matching RoomObject conventions. For wall
  // mounts, y is the bottom edge on the wall; for surface mounts, the host top.
  position: vectorSchema,
  rotationY: z.number().finite(),
  // The product must fit inside this footprint, after margins are removed.
  footprint: footprintSchema,
  maxHeight: z.number().positive().nullable(),
  margins: z.object({
    front: z.number().nonnegative(),
    back: z.number().nonnegative(),
    sides: z.number().nonnegative(),
  }),
  clearanceRules: z.array(z.string()),
  miscellaneous: z.array(z.string()),
  priority: z.number().int().positive(),
  // True when the planner added this beyond what the user asked for.
  suggested: z.boolean(),
});
export const zoneRejectionSchema = z.object({
  zoneId: idSchema,
  reason: z.string(),
});
export const designPlanSchema = z.object({
  roomId: idSchema,
  baseRevision: z.number().int().nonnegative(),
  summary: z.string(),
  zones: z.array(reservedZoneSchema).max(6),
  rejected: z.array(zoneRejectionSchema),
  tasks: z.array(searchTaskSchema).max(6),
});
export const zoneFillSchema = z.object({
  zoneId: idSchema,
  productId: idSchema.nullable(),
  fits: z.enum(["yes", "no", "unknown"]),
  issues: z.array(z.string()),
});
export type Category = z.infer<typeof searchCategorySchema>;
export type ZoneAnchor = z.infer<typeof zoneAnchorSchema>;
export type ZoneMount = z.infer<typeof zoneMountSchema>;
export type ZoneRequest = z.infer<typeof zoneRequestSchema>;
export type ZonePlanRequest = z.infer<typeof zonePlanRequestSchema>;
export type ReservedZone = z.infer<typeof reservedZoneSchema>;
export type ZoneRejection = z.infer<typeof zoneRejectionSchema>;
export type DesignPlan = z.infer<typeof designPlanSchema>;
export type ZoneFill = z.infer<typeof zoneFillSchema>;
export type RoomSnapshot = z.infer<typeof roomSchema>;
export type RoomObject = z.infer<typeof roomObjectSchema>;
export type CapturedSurface = z.infer<typeof capturedSurfaceSchema>;
export type CapturedRoom = Extract<RoomSnapshot, { shape: "polygon" }>;
export type ProductCandidate = z.infer<typeof productSchema>;
export type DesignBrief = z.infer<typeof briefSchema>;
export type ProjectPhase = z.infer<typeof projectPhaseSchema>;
export type Want = z.infer<typeof wantSchema>;
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
