import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects"), ownerId: v.string() },
  handler: async (ctx, { projectId, ownerId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    return await ctx.storage.generateUploadUrl();
  },
});

export const save = mutation({
  args: {
    projectId: v.id("projects"),
    ownerId: v.string(),
    storageId: v.id("_storage"),
    contentType: v.string(),
  },
  handler: async (ctx, { projectId, ownerId, storageId, contentType }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (!contentType.startsWith("image/"))
      throw new Error("Only image uploads are supported.");
    const now = Date.now();
    const imageId = await ctx.db.insert("images", {
      projectId,
      storageId,
      contentType,
      status: "pending",
      createdAt: now,
    });
    const userMessageId = await ctx.db.insert("messages", {
      projectId,
      role: "user",
      imageId,
      content: "I uploaded an inspiration image.",
      status: "done",
      createdAt: now,
    });
    const assistantMessageId: Id<"messages"> = await ctx.db.insert(
      "messages",
      {
        projectId,
        role: "assistant",
        content: "",
        status: "pending",
        createdAt: now + 1,
      },
    );
    await ctx.scheduler.runAfter(0, internal.images.analyze, {
      imageId,
      userMessageId,
      assistantMessageId,
    });
    return imageId;
  },
});

export const get = internalQuery({
  args: { imageId: v.id("images") },
  handler: async (ctx, { imageId }) => {
    const image = await ctx.db.get(imageId);
    if (!image) return null;
    return { ...image, url: await ctx.storage.getUrl(image.storageId) };
  },
});

export const complete = internalMutation({
  args: {
    imageId: v.id("images"),
    userMessageId: v.id("messages"),
    status: v.union(v.literal("analyzed"), v.literal("error")),
    analysis: v.string(),
  },
  handler: async (ctx, { imageId, userMessageId, status, analysis }) => {
    await ctx.db.patch(imageId, { status, analysis });
    await ctx.db.patch(userMessageId, {
      content:
        status === "analyzed"
          ? `I uploaded an inspiration image. Visual analysis: ${analysis}`
          : "I uploaded an inspiration image, but it could not be analyzed.",
    });
  },
});

export const analyze = internalAction({
  args: {
    imageId: v.id("images"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
  },
  handler: async (
    ctx,
    { imageId, userMessageId, assistantMessageId },
  ): Promise<void> => {
    try {
      const image = await ctx.runQuery(internal.images.get, { imageId });
      if (!image?.url) throw new Error("The uploaded image is unavailable.");
      const response = await fetch(image.url);
      if (!response.ok)
        throw new Error(`Image download failed with status ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const result = await generateText({
        model: openai(
          process.env.RUMI_IMAGE_MODEL ??
            process.env.RUMI_EXTRACTION_MODEL ??
            "gpt-4o-mini",
        ),
        system:
          "Analyze an interior-design inspiration image. Be concise and concrete. Identify visible style, palette, materials, lighting, furniture forms, layout cues, and practical ideas worth applying. Do not infer exact dimensions or unseen details.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe the useful design signals in this inspiration image for another room-design agent.",
              },
              {
                type: "image",
                image: bytes,
                mediaType: image.contentType,
              },
            ],
          },
        ],
      });
      await ctx.runMutation(internal.images.complete, {
        imageId,
        userMessageId,
        status: "analyzed",
        analysis: result.text,
      });
      await ctx.runAction(internal.agent.runForProject, {
        projectId: image.projectId,
        messageId: assistantMessageId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      await ctx.runMutation(internal.images.complete, {
        imageId,
        userMessageId,
        status: "error",
        analysis: detail,
      });
      await ctx.runMutation(internal.messages.complete, {
        messageId: assistantMessageId,
        content: `I couldn't analyze that image: ${detail}`,
        status: "error",
      });
    }
  },
});
