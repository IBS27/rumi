import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { z } from "zod";
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
  // ownerId is a device-generated id until real authentication lands.
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
    content: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("done"),
      v.literal("error"),
    ),
    createdAt: v.number(),
  }).index("by_projectId", ["projectId"]),
});
