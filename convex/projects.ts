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

export const rename = mutation({
  args: {
    projectId: v.id("projects"),
    ownerId: v.string(),
    title: v.string(),
  },
  handler: async (ctx, { projectId, ownerId, title }) => {
    const project = await ctx.db.get(projectId);
    const nextTitle = title.trim();
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (!nextTitle) throw new Error("A chat title is required.");
    await ctx.db.patch(projectId, { title: nextTitle.slice(0, 80) });
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), ownerId: v.string() },
  handler: async (ctx, { projectId, ownerId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
    const images = await ctx.db
      .query("images")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    for (const image of images) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete(image._id);
    }
    await ctx.db.delete(project.roomId);
    await ctx.db.delete(projectId);
  },
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
