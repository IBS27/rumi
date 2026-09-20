import { defineSchema, defineTable } from "convex/server";
import { zodToConvex } from "convex-helpers/server/zod4";
import { z } from "zod";
import { v } from "convex/values";
import {
  assetSchema,
  briefSchema,
  designPlanSchema,
  productSchema,
  projectPhaseSchema,
  proposalSchema,
  roomSchema,
  roomObjectSchema,
} from "../shared/contracts";

// Briefs stored before the Spec stage lack its fields. Storage allows their
// absence; normalizeBrief fills the defaults on every read.
const briefFields = zodToConvex(briefSchema).fields;
export const storedBrief = v.object({
  ...briefFields,
  palette: v.optional(briefFields.palette),
  materials: v.optional(briefFields.materials),
  purpose: v.optional(briefFields.purpose),
  wants: v.optional(briefFields.wants),
  accessories: v.optional(briefFields.accessories),
  inspiration: v.optional(briefFields.inspiration),
  decided: v.optional(briefFields.decided),
});

// A filled zone: which product was chosen and whether it fits the reservation.
export const zoneRecommendation = v.object({
  zoneId: v.string(),
  productId: v.union(v.string(), v.null()),
  fits: v.union(v.literal("yes"), v.literal("no"), v.literal("unknown")),
  issues: v.array(v.string()),
});

// Zod refinements must also run at function boundaries; Convex validates storage shapes.
export default defineSchema({
  roomReconstructions: defineTable({
    ownerId: v.string(),
    digest: v.string(),
    inputId: v.id("_storage"),
    planId: v.optional(v.id("_storage")),
    batches: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          objectIds: v.array(v.string()),
        }),
      ),
    ),
    step: v.optional(v.number()),
    stage: v.union(
      v.literal("queued"),
      v.literal("analyzing"),
      v.literal("modeling"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    completed: v.number(),
    total: v.number(),
    attempt: v.number(),
    sceneJson: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_ownerId_digest", ["ownerId", "digest"])
    .index("by_ownerId_stage", ["ownerId", "stage"])
    .index("by_ownerId", ["ownerId"]),
  rooms: defineTable({
    ownerId: v.string(),
    snapshot: zodToConvex(roomSchema),
    brief: storedBrief,
    history: v.optional(v.array(v.array(zodToConvex(roomObjectSchema)))),
  }).index("by_ownerId", ["ownerId"]),
  products: defineTable(zodToConvex(productSchema)).index("by_catalog_id", [
    "id",
  ]),
  assets: defineTable(zodToConvex(assetSchema)).index("by_catalog_id", ["id"]),
  proposals: defineTable(
    zodToConvex(z.object({ ownerId: z.string(), proposal: proposalSchema })),
  ).index("by_ownerId", ["ownerId"]),
  // ownerId is the authenticated identity tokenIdentifier.
  projects: defineTable({
    ownerId: v.string(),
    title: v.string(),
    roomId: v.optional(v.id("rooms")),
    brief: v.optional(storedBrief),
    phase: v.optional(zodToConvex(projectPhaseSchema)),
    activeMessageId: v.optional(v.id("messages")),
    createdAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),
  messages: defineTable({
    projectId: v.id("projects"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    kind: v.optional(v.union(v.literal("question"), v.literal("plan"))),
    imageId: v.optional(v.id("images")),
    // A plan card points at the persisted plan it shows.
    planId: v.optional(v.id("plans")),
    recommendationProductId: v.optional(v.string()),
    // One entry per searched zone. recommendationProductId stays for older
    // single-product replies.
    recommendations: v.optional(v.array(zoneRecommendation)),
    content: v.string(),
    selectedObjectId: v.optional(v.string()),
    activity: v.optional(
      v.array(
        v.object({
          id: v.string(),
          tool: v.string(),
          label: v.string(),
          detail: v.optional(v.string()),
          status: v.union(
            v.literal("running"),
            v.literal("done"),
            v.literal("error"),
          ),
        }),
      ),
    ),
    options: v.optional(v.array(v.string())),
    multiSelect: v.optional(v.boolean()),
    answer: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("error"),
    ),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),
  // Reserved zones for a room, waiting for the user to confirm which to shop.
  plans: defineTable({
    projectId: v.id("projects"),
    roomId: v.id("rooms"),
    plan: zodToConvex(designPlanSchema),
    // Zone ids the user kept on the plan card; unset until they choose.
    selectedZoneIds: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("proposed"),
      v.literal("searching"),
      v.literal("searched"),
      v.literal("superseded"),
    ),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),
  images: defineTable({
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("analyzed"),
      v.literal("error"),
    ),
    analysis: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),
  imageUploads: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    tokenHash: v.string(),
    contentType: v.string(),
    size: v.number(),
    expiresAt: v.number(),
  }).index("by_projectId", ["projectId"]),
  captures: defineTable({
    ownerId: v.string(),
    state: v.union(
      v.literal("waiting"),
      v.literal("paired"),
      v.literal("uploaded"),
      v.literal("canceled"),
    ),
    pairingHash: v.string(),
    pairingExpiresAt: v.number(),
    expiresAt: v.number(),
    claimId: v.optional(v.string()),
    uploadHash: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    digest: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    uploadAttempts: v.number(),
    format: v.optional(v.union(v.literal("json"), v.literal("zip"))),
    scanUpload: v.optional(
      v.object({
        idempotencyKey: v.string(),
        digest: v.string(),
        size: v.number(),
        startedAt: v.number(),
      }),
    ),
    scanValidationAttempts: v.optional(v.number()),
    scanStorageId: v.optional(v.id("_storage")),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_scanStorageId", ["scanStorageId"]),
});
