import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireOwner } from "./ownership";
import schema from "./schema";
import { zodToConvex } from "convex-helpers/server/zod4";
import { paginationOptsValidator } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { roomSchema } from "../shared/contracts";

const projectDoc = v.object({
  ...schema.tables.projects.validator.fields,
  _id: v.id("projects"),
  _creationTime: v.number(),
});

export const list = query({
  returns: v.object({
    page: v.array(projectDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const ownerId = await requireOwner(ctx);
    return await ctx.db
      .query("projects")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const rename = mutation({
  returns: v.null(),
  args: {
    projectId: v.id("projects"),
    title: v.string(),
  },
  handler: async (ctx, { projectId, title }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    const nextTitle = title.trim();
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (!nextTitle) throw new Error("A chat title is required.");
    await ctx.db.patch(projectId, { title: nextTitle.slice(0, 80) });
  },
});

export const remove = mutation({
  returns: v.null(),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    await ctx.db.delete(project.roomId);
    await ctx.db.delete(projectId);
    await ctx.scheduler.runAfter(0, internal.projects.cleanup, { projectId });
  },
});

// Delete children in bounded batches after making the project inaccessible.
export const cleanup = internalMutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .take(100);
    const images = await ctx.db
      .query("images")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .take(100);
    for (const message of messages) await ctx.db.delete(message._id);
    for (const image of images) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete(image._id);
    }
    if (messages.length === 100 || images.length === 100)
      await ctx.scheduler.runAfter(0, internal.projects.cleanup, { projectId });
  },
});

export const get = internalQuery({
  returns: v.union(projectDoc, v.null()),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => await ctx.db.get(projectId),
});

export const create = mutation({
  returns: v.id("projects"),
  args: { title: v.string(), room: zodToConvex(roomSchema) },
  handler: async (ctx, { title, room }): Promise<Id<"projects">> => {
    const ownerId = await requireOwner(ctx);
    title = title.trim().slice(0, 80);
    if (!title) throw new Error("A project title is required.");
    const roomId = await ctx.db.insert("rooms", {
      ownerId,
      snapshot: roomSchema.parse(room),
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
