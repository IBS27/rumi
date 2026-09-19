import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { v } from "convex/values";
import schema from "./schema";
import {
  mutation,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./ownership";
import { hashToken, randomToken } from "../shared/capture/pairing";
import {
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  validImageHeader,
} from "../shared/chat/uploads";
import type { Id } from "./_generated/dataModel";

export const beginUpload = mutation({
  args: {
    projectId: v.id("projects"),
    contentType: v.string(),
    size: v.number(),
  },
  returns: v.object({ uploadUrl: v.string(), token: v.string() }),
  handler: async (ctx, { projectId, contentType, size }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (project.activeMessageId)
      throw new Error("Please wait for the current reply.");
    if (
      !IMAGE_TYPES.includes(contentType) ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > MAX_IMAGE_BYTES
    )
      throw new Error(
        "Choose a JPEG, PNG, WebP, or GIF image of 10 MB or less.",
      );
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new Error("Image uploads are not configured.");
    const outstanding = await ctx.db
      .query("imageUploads")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .take(5);
    if (outstanding.length >= 5)
      throw new Error("Too many pending uploads. Try again in a few minutes.");
    const token = randomToken();
    const uploadId = await ctx.db.insert("imageUploads", {
      projectId,
      ownerId,
      contentType,
      size,
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + 600000,
    });
    await ctx.scheduler.runAfter(600000, internal.images.expireUpload, {
      uploadId,
    });
    return { uploadUrl: `${site}/chat/image?uploadId=${uploadId}`, token };
  },
});

export const expireUpload = internalMutation({
  args: { uploadId: v.id("imageUploads") },
  returns: v.null(),
  handler: async (ctx, { uploadId }) => {
    if (await ctx.db.get(uploadId)) await ctx.db.delete(uploadId);
  },
});

export const uploadTicket = internalQuery({
  args: { uploadId: v.id("imageUploads"), tokenHash: v.string() },
  returns: v.union(v.null(), schema.tables.imageUploads.validator),
  handler: async (ctx, { uploadId, tokenHash }) => {
    const ticket = await ctx.db.get(uploadId);
    if (!ticket || ticket.tokenHash !== tokenHash) return null;
    const project = await ctx.db.get(ticket.projectId);
    if (!project || project.ownerId !== ticket.ownerId) return null;
    const { _id: _id, _creationTime: _time, ...value } = ticket;
    void _id;
    void _time;
    return value;
  },
});

function uploadCors(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowed = (process.env.CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim());
  if (origin && allowed.includes(origin))
    headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return headers;
}
export const uploadOptions = httpAction(
  async (_ctx, request) =>
    new Response(null, { status: 204, headers: uploadCors(request) }),
);

export const upload = httpAction(async (ctx, request) => {
  const headers = uploadCors(request);
  let storageId: Id<"_storage"> | undefined;
  try {
    const uploadId = new URL(request.url).searchParams.get(
      "uploadId",
    ) as Id<"imageUploads"> | null;
    const token = request.headers
      .get("Authorization")
      ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!uploadId || !token)
      return new Response("Upload authorization required.", {
        status: 401,
        headers,
      });
    const tokenHash = await hashToken(token);
    const ticket = await ctx.runQuery(internal.images.uploadTicket, {
      uploadId,
      tokenHash,
    });
    if (!ticket || ticket.expiresAt <= Date.now())
      return new Response(
        "This upload has expired. Please attach the image again.",
        { status: 403, headers },
      );
    if (
      request.headers.get("Content-Type") !== ticket.contentType ||
      Number(request.headers.get("Content-Length")) > MAX_IMAGE_BYTES
    )
      return new Response("Invalid image upload.", { status: 400, headers });
    if (!request.body)
      return new Response("Choose an image.", { status: 400, headers });
    const reader = request.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > ticket.size || size > MAX_IMAGE_BYTES)
          throw new Error("The image is too large.");
        chunks.push(new Uint8Array(part.value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const blob = new Blob(chunks, { type: ticket.contentType });
    const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (size !== ticket.size || !validImageHeader(header, ticket.contentType))
      throw new Error("The file does not match its image type.");
    storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.images.save, {
      uploadId,
      tokenHash,
      storageId,
    });
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    if (storageId) await ctx.storage.delete(storageId);
    console.error("Image upload failed", error);
    return new Response("The image could not be attached. Please try again.", {
      status: 400,
      headers,
    });
  }
});

export const save = internalMutation({
  returns: v.id("images"),
  args: {
    uploadId: v.id("imageUploads"),
    tokenHash: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { uploadId, tokenHash, storageId }) => {
    const ticket = await ctx.db.get(uploadId);
    if (
      !ticket ||
      ticket.tokenHash !== tokenHash ||
      ticket.expiresAt <= Date.now()
    )
      throw new Error("Upload expired.");
    const { projectId, ownerId, contentType } = ticket;
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (project.activeMessageId)
      throw new Error("Please wait for the current reply.");
    await ctx.db.delete(uploadId);
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
    const assistantMessageId: Id<"messages"> = await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: now + 1,
    });
    await ctx.db.patch(projectId, { activeMessageId: assistantMessageId });
    await ctx.scheduler.runAfter(180000, internal.messages.expire, {
      messageId: assistantMessageId,
    });
    await ctx.scheduler.runAfter(0, internal.images.analyze, {
      imageId,
      userMessageId,
      assistantMessageId,
    });
    return imageId;
  },
});

export const get = internalQuery({
  returns: v.union(
    v.null(),
    v.object({
      ...schema.tables.images.validator.fields,
      _id: v.id("images"),
      _creationTime: v.number(),
      url: v.union(v.string(), v.null()),
    }),
  ),
  args: { imageId: v.id("images") },
  handler: async (ctx, { imageId }) => {
    const image = await ctx.db.get(imageId);
    if (!image) return null;
    return { ...image, url: await ctx.storage.getUrl(image.storageId) };
  },
});

export const complete = internalMutation({
  returns: v.null(),
  args: {
    imageId: v.id("images"),
    userMessageId: v.id("messages"),
    status: v.union(v.literal("analyzed"), v.literal("error")),
    analysis: v.string(),
  },
  handler: async (ctx, { imageId, userMessageId, status, analysis }) => {
    if (!(await ctx.db.get(imageId)) || !(await ctx.db.get(userMessageId)))
      return;
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
  returns: v.null(),
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
        throw new Error(
          `Image download failed with status ${response.status}.`,
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!process.env.OPENAI_API_KEY)
        throw new Error("Image analysis is not configured yet.");
      const result = await generateText({
        abortSignal: AbortSignal.timeout(60000),
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
      console.error("Image analysis failed:", detail);
      await ctx.runMutation(internal.images.complete, {
        imageId,
        userMessageId,
        status: "error",
        analysis: detail,
      });
      await ctx.runMutation(internal.messages.complete, {
        messageId: assistantMessageId,
        content: "I couldn’t analyze that image. Please try again.",
        status: "error",
      });
    }
  },
});
