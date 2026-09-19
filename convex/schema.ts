import { defineSchema, defineTable } from "convex/server";
import { zodToConvex } from "convex-helpers/server/zod4";
import { z } from "zod";
import { v } from "convex/values";
import {
  assetSchema,
  briefSchema,
  productSchema,
  proposalSchema,
  roomSchema,
} from "../shared/contracts";

// Zod refinements must also run at function boundaries; Convex validates storage shapes.
export default defineSchema({
  rooms: defineTable(
    zodToConvex(
      z.object({
        ownerId: z.string(),
        snapshot: roomSchema,
        brief: briefSchema,
      }),
    ),
  ).index("by_ownerId", ["ownerId"]),
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
    roomId: v.id("rooms"),
    createdAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),
  messages: defineTable({
    projectId: v.id("projects"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    kind: v.optional(v.literal("question")),
    imageId: v.optional(v.id("images")),
    content: v.string(),
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
  }).index("by_ownerId", ["ownerId"]),
});
