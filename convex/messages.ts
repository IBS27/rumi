import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const list = query({
  args: { projectId: v.id("projects"), ownerId: v.string() },
  handler: async (ctx, { projectId, ownerId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId) return null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    return await Promise.all(
      messages.map(async (message) => {
        if (!message.imageId) return { ...message, imageUrl: null };
        const image = await ctx.db.get(message.imageId);
        return {
          ...message,
          imageUrl: image ? await ctx.storage.getUrl(image.storageId) : null,
        };
      }),
    );
  },
});

async function postUserTurn(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  ownerId: string,
  content: string,
) {
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
}

export const send = mutation({
  args: {
    projectId: v.id("projects"),
    ownerId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, { projectId, ownerId, content }) =>
    await postUserTurn(ctx, projectId, ownerId, content),
});

export const ask = internalMutation({
  args: {
    projectId: v.id("projects"),
    question: v.string(),
    options: v.array(v.string()),
    multiSelect: v.boolean(),
  },
  handler: async (ctx, { projectId, question, options, multiSelect }) =>
    await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      kind: "question",
      content: question,
      options,
      multiSelect,
      status: "pending",
      createdAt: Date.now(),
    }),
});

export const answer = mutation({
  args: {
    messageId: v.id("messages"),
    ownerId: v.string(),
    choice: v.array(v.string()),
  },
  handler: async (ctx, { messageId, ownerId, choice }) => {
    const question = await ctx.db.get(messageId);
    if (!question || question.kind !== "question" || question.answer)
      throw new Error("This question does not exist.");
    await ctx.db.patch(messageId, { answer: choice, status: "done" });
    return await postUserTurn(
      ctx,
      question.projectId,
      ownerId,
      `${question.content} — ${choice.join(", ")}`,
    );
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
