import { v } from "convex/values";
import { requireOwner } from "./ownership";
import schema from "./schema";
import { paginationOptsValidator } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const messageDoc = v.object({
  ...schema.tables.messages.validator.fields,
  _id: v.id("messages"),
  _creationTime: v.number(),
});
const listedMessage = v.object({
  ...messageDoc.fields,
  imageUrl: v.union(v.string(), v.null()),
});

export const list = query({
  returns: v.object({
    page: v.array(listedMessage),
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
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { projectId, paginationOpts }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      return { page: [], isDone: true, continueCursor: "" };
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(
      messages.page.map(async (message) => {
        if (!message.imageId) return { ...message, imageUrl: null };
        const image = await ctx.db.get(message.imageId);
        return {
          ...message,
          imageUrl: image ? await ctx.storage.getUrl(image.storageId) : null,
        };
      }),
    );
    return { ...messages, page };
  },
});

export async function postUserTurn(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  ownerId: string,
  content: string,
) {
  const project = await ctx.db.get(projectId);
  if (!project || project.ownerId !== ownerId)
    throw new Error("This project does not exist.");
  content = content.trim();
  if (!content || content.length > 16000)
    throw new Error("Message must contain 1–16000 characters.");
  if (project.activeMessageId)
    throw new Error("Please wait for the current reply.");
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
  await ctx.db.patch(projectId, { activeMessageId: messageId });
  await ctx.scheduler.runAfter(180000, internal.messages.expire, { messageId });
  await ctx.scheduler.runAfter(0, internal.agent.runForProject, {
    projectId,
    messageId,
  });
  return messageId;
}

export const send = mutation({
  returns: v.id("messages"),
  args: {
    projectId: v.id("projects"),
    content: v.string(),
  },
  handler: async (ctx, { projectId, content }) =>
    await postUserTurn(ctx, projectId, await requireOwner(ctx), content),
});

export const ask = internalMutation({
  returns: v.id("messages"),
  args: {
    projectId: v.id("projects"),
    question: v.string(),
    options: v.array(v.string()),
    multiSelect: v.boolean(),
  },
  handler: async (ctx, { projectId, question, options, multiSelect }) => {
    if (!(await ctx.db.get(projectId)))
      throw new Error("This project does not exist.");
    return await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      kind: "question",
      content: question,
      options,
      multiSelect,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const answer = mutation({
  returns: v.id("messages"),
  args: {
    messageId: v.id("messages"),
    choice: v.array(v.string()),
  },
  handler: async (ctx, { messageId, choice }) => {
    const ownerId = await requireOwner(ctx);
    const question = await ctx.db.get(messageId);
    if (!question || question.kind !== "question" || question.answer)
      throw new Error("This question does not exist.");
    const project = await ctx.db.get(question.projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (choice.length === 0 || (!question.multiSelect && choice.length !== 1))
      throw new Error("Choose an answer.");
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
  returns: v.null(),
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
  },
  handler: async (ctx, { messageId, content, status }) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.status !== "pending") return;
    await ctx.db.patch(messageId, { content, status });
    const project = await ctx.db.get(message.projectId);
    if (project?.activeMessageId === messageId)
      await ctx.db.patch(project._id, { activeMessageId: undefined });
  },
});

export const history = internalQuery({
  returns: v.array(messageDoc),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }): Promise<Doc<"messages">[]> =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .order("desc")
        .take(100)
    ).reverse(),
});

export const expire = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.status !== "pending") return;
    await ctx.runMutation(internal.messages.complete, {
      messageId,
      status: "error",
      content: "The reply took too long. Please try again.",
    });
  },
});

export const retry = mutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, { messageId }) => {
    const ownerId = await requireOwner(ctx);
    const message = await ctx.db.get(messageId);
    if (!message || message.role !== "assistant" || message.status !== "error")
      throw new Error("This reply cannot be retried.");
    const project = await ctx.db.get(message.projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (project.activeMessageId)
      throw new Error("Please wait for the current reply.");
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (latest?._id !== messageId)
      throw new Error("Send a new message to continue this conversation.");
    const replyId = await ctx.db.insert("messages", {
      projectId: project._id,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: Date.now(),
    });
    await ctx.db.patch(project._id, { activeMessageId: replyId });
    await ctx.scheduler.runAfter(180000, internal.messages.expire, {
      messageId: replyId,
    });
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(100);
    const previous = recent.find((item) => item.role === "user");
    const image = previous?.imageId ? await ctx.db.get(previous.imageId) : null;
    if (image && previous && image.status !== "analyzed") {
      await ctx.scheduler.runAfter(0, internal.images.analyze, {
        imageId: image._id,
        userMessageId: previous._id,
        assistantMessageId: replyId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.agent.runForProject, {
        projectId: project._id,
        messageId: replyId,
      });
    }
  },
});
