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
// No public functions are exposed until authentication and deployment ownership are set.
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
