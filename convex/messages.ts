import { v } from "convex/values";
import { requireOwner } from "./ownership";
import schema, { zoneRecommendation } from "./schema";
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
import { SPEC_SUMMARY_OPTIONS } from "../shared/chat/spec";
import { briefSchema } from "../shared/contracts";
import { inferBriefPurpose } from "../shared/chat/purpose";

const isSpecSummary = (options: string[]) =>
  options.length === SPEC_SUMMARY_OPTIONS.length &&
  options.every((option, index) => option === SPEC_SUMMARY_OPTIONS[index]);

const activityValidator = v.object({
  id: v.string(),
  tool: v.string(),
  label: v.string(),
  detail: v.optional(v.string()),
  status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
});

const planningActivity = () => [
  {
    id: "planning",
    tool: "planning",
    label: "Planning",
    status: "running" as const,
  },
];

const messageDoc = v.object({
  ...schema.tables.messages.validator.fields,
  _id: v.id("messages"),
  _creationTime: v.number(),
});
const productCard = v.object({
  id: v.string(),
  name: v.string(),
  merchant: v.string(),
  sourceUrl: v.string(),
  imageUrl: v.union(v.string(), v.null()),
  priceCents: v.number(),
});
const planZoneCard = v.object({
  id: v.string(),
  category: v.string(),
  purpose: v.string(),
  mount: v.string(),
  footprint: v.object({ width: v.number(), depth: v.number() }),
  where: v.string(),
  suggested: v.boolean(),
});
const planCard = v.object({
  planId: v.id("plans"),
  status: v.string(),
  spacing: v.string(),
  zones: v.array(planZoneCard),
  rejected: v.array(v.object({ zoneId: v.string(), reason: v.string() })),
});
const zoneCard = v.object({
  zoneId: v.string(),
  category: v.string(),
  fits: v.union(v.literal("yes"), v.literal("no"), v.literal("unknown")),
  issues: v.array(v.string()),
  product: v.union(productCard, v.null()),
});
const listedMessage = v.object({
  ...messageDoc.fields,
  imageUrl: v.union(v.string(), v.null()),
  imageAnalysis: v.union(v.string(), v.null()),
  recommendation: v.union(productCard, v.null()),
  plan: v.union(planCard, v.null()),
  zoneCards: v.array(zoneCard),
});

// Where a reserved zone sits, in words the card can show.
function describeWhere(
  zone: {
    mount: string;
    anchor: string;
    relatedObjectId: string | null;
    position: { x: number; z: number };
  },
  room: { dimensions: { width: number; depth: number } } | null,
  names: Map<string, string>,
): string {
  const raw = zone.relatedObjectId ? names.get(zone.relatedObjectId) : null;
  // "Your bed" → "your bed"; "the your bed" would read badly.
  const host = raw ? raw.replace(/^(the|your|my)\s+/, "") : null;
  if (zone.mount === "surface") return host ? `on the ${host}` : "on a surface";
  if (zone.mount === "under")
    return host ? `under the ${host}` : "on the floor";
  if (zone.mount === "wall") return "on the wall";
  if (host) return `beside the ${host}`;
  if (!room) return "on the floor";
  const { width, depth } = room.dimensions;
  const nearX =
    zone.position.x < width * 0.3
      ? "left"
      : zone.position.x > width * 0.7
        ? "right"
        : "";
  const nearZ =
    zone.position.z < depth * 0.3
      ? "back"
      : zone.position.z > depth * 0.7
        ? "front"
        : "";
  const spot = [nearZ, nearX].filter(Boolean).join(" ");
  return spot
    ? `${spot} ${zone.anchor === "corner" ? "corner" : "wall"}`
    : "center of the room";
}

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
    const room = project.roomId ? await ctx.db.get(project.roomId) : null;
    const names = new Map(
      (room?.snapshot.objects ?? []).map((object) => [
        object.id,
        object.name.toLowerCase(),
      ]),
    );
    const productById = async (id: string) => {
      const product = await ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", id))
        .unique();
      return product?.measurement.dimensions
        ? {
            id: product.id,
            name: product.name,
            merchant: product.merchant,
            sourceUrl: product.sourceUrl,
            imageUrl: product.imageUrl,
            priceCents: product.priceCents,
          }
        : null;
    };
    const page = await Promise.all(
      messages.page.map(async (message) => {
        const [image, product, planDoc] = await Promise.all([
          message.imageId ? ctx.db.get(message.imageId) : null,
          message.recommendationProductId
            ? productById(message.recommendationProductId)
            : null,
          message.planId ? ctx.db.get(message.planId) : null,
        ]);
        const zoneNames = new Map(names);
        for (const zone of planDoc?.plan.zones ?? [])
          zoneNames.set(zone.id, zone.category.toLowerCase());
        const plan = planDoc
          ? {
              planId: planDoc._id,
              status: planDoc.status,
              spacing: planDoc.plan.spacing,
              zones: planDoc.plan.zones.map((zone) => ({
                id: zone.id,
                category: zone.category,
                purpose: zone.purpose,
                mount: zone.mount,
                footprint: zone.footprint,
                where: describeWhere(zone, room?.snapshot ?? null, zoneNames),
                suggested: zone.suggested,
              })),
              rejected: planDoc.plan.rejected,
            }
          : null;
        // The searched plan's zones give each product card its category.
        const searched = message.recommendations?.length
          ? await ctx.db
              .query("plans")
              .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
              .order("desc")
              .take(10)
          : [];
        const categoryOf = new Map<string, string>();
        for (const item of searched)
          for (const zone of item.plan.zones)
            if (!categoryOf.has(zone.id))
              categoryOf.set(zone.id, zone.category);
        const zoneCards = await Promise.all(
          (message.recommendations ?? []).map(async (item) => ({
            zoneId: item.zoneId,
            category: categoryOf.get(item.zoneId) ?? item.zoneId,
            fits: item.fits,
            issues: item.issues,
            product: item.productId ? await productById(item.productId) : null,
          })),
        );
        return {
          ...message,
          imageUrl: image ? await ctx.storage.getUrl(image.storageId) : null,
          imageAnalysis:
            image?.status === "analyzed" ? (image.analysis ?? null) : null,
          recommendation: product,
          plan,
          zoneCards,
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
  selectedObjectId?: string,
) {
  const project = await ctx.db.get(projectId);
  if (!project || project.ownerId !== ownerId)
    throw new Error("This project does not exist.");
  content = content.trim();
  if (!content || content.length > 16000)
    throw new Error("Message must contain 1–16000 characters.");
  if (project.activeMessageId)
    throw new Error("Please wait for the current reply.");
  const room = project.roomId ? await ctx.db.get(project.roomId) : null;
  const storedBrief = briefSchema.parse({
    prompt: "",
    styles: [],
    budgetCents: 0,
    currency: "USD",
    restrictions: [],
    ...(project.brief ?? {}),
    ...(room?.brief ?? {}),
  });
  const inferredBrief = inferBriefPurpose(
    storedBrief,
    content,
    room?.snapshot ?? null,
  );
  if (inferredBrief !== storedBrief) {
    await ctx.db.patch(projectId, { brief: inferredBrief });
    if (room) await ctx.db.patch(room._id, { brief: inferredBrief });
  }
  if (selectedObjectId) {
    if (
      !room?.snapshot.objects.some((object) => object.id === selectedObjectId)
    )
      throw new Error("The selected item is no longer in this room.");
  }
  const now = Date.now();
  await ctx.db.insert("messages", {
    projectId,
    role: "user",
    selectedObjectId,
    content,
    status: "done",
    createdAt: now,
  });
  const messageId: Id<"messages"> = await ctx.db.insert("messages", {
    projectId,
    role: "assistant",
    selectedObjectId,
    content: "",
    activity: planningActivity(),
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
    selectedObjectId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, content, selectedObjectId }) =>
    await postUserTurn(
      ctx,
      projectId,
      await requireOwner(ctx),
      content,
      selectedObjectId,
    ),
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
    // The spec summary card moves the stage itself. Leaving this to the model
    // let it re-show the summary in a loop.
    const summaryCard = isSpecSummary(question.options ?? []);
    if (summaryCard && choice[0] === SPEC_SUMMARY_OPTIONS[0]) {
      if (!project.roomId)
        return await postUserTurn(
          ctx,
          question.projectId,
          ownerId,
          "Start planning. (No room is attached yet.)",
        );
      await ctx.db.patch(project._id, { phase: "plan" });
      return await postUserTurn(
        ctx,
        question.projectId,
        ownerId,
        "Start planning.",
      );
    }
    // Echo the question's first line only; a long card must not become the
    // user's whole message.
    const heading =
      question.content.split("\n").find((line) => line.trim()) ?? "";
    const prefix = summaryCard ? "" : `${heading.slice(0, 160)} — `;
    return await postUserTurn(
      ctx,
      question.projectId,
      ownerId,
      `${prefix}${choice.join(", ")}`,
    );
  },
});

export const updateProgress = internalMutation({
  returns: v.null(),
  args: {
    messageId: v.id("messages"),
    content: v.string(),
    activity: v.array(activityValidator),
    recommendationProductId: v.optional(v.union(v.string(), v.null())),
    recommendations: v.optional(v.array(zoneRecommendation)),
  },
  handler: async (
    ctx,
    { messageId, content, activity, recommendationProductId, recommendations },
  ) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.status !== "pending") return;
    const project = await ctx.db.get(message.projectId);
    if (!project || project.activeMessageId !== messageId) return;
    await ctx.db.patch(messageId, {
      content: content.slice(0, 16000),
      activity: activity.slice(-20),
      // Omission preserves the card; null explicitly clears a previous result.
      ...(recommendationProductId !== undefined
        ? { recommendationProductId: recommendationProductId ?? undefined }
        : {}),
      ...(recommendations !== undefined ? { recommendations } : {}),
    });
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
    await ctx.db.patch(messageId, {
      content,
      status,
      activity: message.activity?.map((item) => ({
        ...item,
        status:
          item.status === "running"
            ? status === "error"
              ? ("error" as const)
              : ("done" as const)
            : item.status,
      })),
    });
    const project = await ctx.db.get(message.projectId);
    if (project?.activeMessageId === messageId)
      await ctx.db.patch(project._id, { activeMessageId: undefined });
  },
});

// The agent's view of the conversation. An image message carries its visual
// analysis inline so the model sees the cues without them cluttering the chat.
export const history = internalQuery({
  returns: v.array(messageDoc),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }): Promise<Doc<"messages">[]> => {
    const messages = (
      await ctx.db
        .query("messages")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .order("desc")
        .take(100)
    ).reverse();
    return await Promise.all(
      messages.map(async (message) => {
        if (!message.imageId) return message;
        const image = await ctx.db.get(message.imageId);
        return image?.status === "analyzed" && image.analysis
          ? {
              ...message,
              content: `${message.content} Visual analysis: ${image.analysis}`,
            }
          : message;
      }),
    );
  },
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
      selectedObjectId: message.selectedObjectId,
      content: "",
      activity: planningActivity(),
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
