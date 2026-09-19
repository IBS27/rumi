import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const list = query({
  args: { projectId: v.id("projects"), ownerId: v.string() },
  handler: async (ctx, { projectId, ownerId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId) return null;
    return await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
  },
});

export const send = mutation({
  args: {
    projectId: v.id("projects"),
    ownerId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, { projectId, ownerId, content }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    const now = Date.now();
    await ctx.db.insert("messages", {
      projectId,
      role: "user",
      content,
      status: "done",
      createdAt: now,
    });
    const messageId: Id<"messages"> = await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: now + 1,
    });
    await ctx.scheduler.runAfter(0, internal.agent.runForProject, {
      projectId,
      messageId,
    });
    return messageId;
  },
});

export const complete = internalMutation({
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
  },
  handler: async (ctx, { messageId, content, status }) => {
    await ctx.db.patch(messageId, { content, status });
  },
});

export const history = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }): Promise<Doc<"messages">[]> =>
    await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect(),
});
