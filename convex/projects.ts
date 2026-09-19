import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { roomSchema } from "../shared/contracts";

export const list = query({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }): Promise<Doc<"projects">[]> =>
    await ctx.db
      .query("projects")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect(),
});

export const get = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => await ctx.db.get(projectId),
});

export const create = mutation({
  args: { ownerId: v.string(), title: v.string() },
  handler: async (ctx, { ownerId, title }): Promise<Id<"projects">> => {
    const roomId = await ctx.db.insert("rooms", {
      ownerId,
      snapshot: roomSchema.parse({
        id: `room-${crypto.randomUUID()}`,
        name: title,
        revision: 0,
        shape: "rectangle",
        dimensions: { width: 4, height: 2.7, depth: 3 },
        measurementSource: "estimated",
        openings: [],
        objects: [],
      }),
      brief: {
        prompt: "",
        styles: [],
        budgetCents: 0,
        currency: "USD",
        restrictions: [],
      },
    });
    return await ctx.db.insert("projects", {
      ownerId,
      title,
      roomId,
      createdAt: Date.now(),
    });
  },
});
