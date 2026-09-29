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
  reservedZoneSchema,
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
  sourceCache: defineTable({
    key: v.string(),
    token: v.string(),
    leaseUntil: v.number(),
    expiresAt: v.number(),
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAt"])
    .index("by_storageId", ["storageId"]),
  accountDeletions: defineTable({
    ownerId: v.string(),
    subject: v.optional(v.string()),
    requestedAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("identity-pending"),
    ),
    error: v.optional(v.string()),
  }).index("by_ownerId", ["ownerId"]),
  operatorEvents: defineTable({
    operation: v.string(),
    createdAt: v.number(),
    count: v.number(),
  }),
  files: defineTable({
    projectId: v.id("projects"),
    ownerId: v.string(),
    kind: v.union(v.literal("workspace"), v.literal("scan")),
    size: v.number(),
    chunks: v.array(v.id("_storage")),
    tokenHash: v.string(),
    expiresAt: v.number(),
    complete: v.boolean(),
  }).index("by_projectId", ["projectId"]),
  fileTickets: defineTable({
    ownerId: v.string(),
    projectId: v.optional(v.id("projects")),
    captureId: v.optional(v.id("captures")),
    fileId: v.optional(v.id("files")),
    imageId: v.optional(v.id("images")),
    tokenHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_projectId", ["projectId"])
    .index("by_hash", ["tokenHash"]),
  designCommands: defineTable({
    projectId: v.id("projects"),
    key: v.string(),
    request: v.string(),
    snapshot: zodToConvex(roomSchema),
  })
    .index("by_project_key", ["projectId", "key"])
    .index("by_projectId", ["projectId"]),
  recommendations: defineTable({
    projectId: v.id("projects"),
    messageId: v.id("messages"),
    planId: v.optional(v.id("plans")),
    zone: v.union(zodToConvex(reservedZoneSchema), v.null()),
    result: zoneRecommendation,
    product: v.union(zodToConvex(productSchema), v.null()),
    explanation: v.string(),
  })
    .index("by_projectId", ["projectId"])
    .index("by_plan_zone", ["planId", "result.zoneId"])
    .index("by_message_zone", ["messageId", "result.zoneId"]),
  agentSteps: defineTable({
    projectId: v.id("projects"),
    messageId: v.id("messages"),
    step: v.number(),
    model: v.optional(v.string()),
    usage: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    response: v.string(),
    calls: v.string(),
    outputs: v.string(),
    text: v.string(),
  })
    .index("by_message_step", ["messageId", "step"])
    .index("by_projectId", ["projectId"]),
  roomReconstructions: defineTable({
    projectId: v.optional(v.id("projects")),
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
    .index("by_projectId", ["projectId"])
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
  offerObservations: defineTable({
    productId: v.string(),
    digest: v.string(),
    observedAt: v.number(),
    product: zodToConvex(productSchema),
  }).index("by_productId_digest", ["productId", "digest"]),
  assets: defineTable(zodToConvex(assetSchema)).index("by_catalog_id", ["id"]),
  proposals: defineTable(
    zodToConvex(z.object({ ownerId: z.string(), proposal: proposalSchema })),
  ).index("by_ownerId", ["ownerId"]),
  // ownerId is the authenticated identity tokenIdentifier.
  projects: defineTable({
    ownerId: v.string(),
    title: v.string(),
    importKey: v.optional(v.string()),
    migrationVersion: v.optional(v.number()),
    workspaceFileId: v.optional(v.id("files")),
    scanFileId: v.optional(v.id("files")),
    roomId: v.optional(v.id("rooms")),
    brief: v.optional(storedBrief),
    phase: v.optional(zodToConvex(projectPhaseSchema)),
    activeMessageId: v.optional(v.id("messages")),
    createdAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_owner_import", ["ownerId", "importKey"]),
  messages: defineTable({
    operationKey: v.optional(v.string()),
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
  })
    .index("by_projectId", ["projectId"])
    .index("by_operation", ["projectId", "operationKey"]),
  // Reserved zones for a room, waiting for the user to confirm which to shop.
  plans: defineTable({
    operationKey: v.optional(v.string()),
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
  })
    .index("by_projectId", ["projectId"])
    .index("by_operation", ["projectId", "operationKey"]),
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
  captureChunks: defineTable({
    captureId: v.id("captures"),
    index: v.number(),
    storageId: v.id("_storage"),
  }).index("by_capture_index", ["captureId", "index"]),
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
