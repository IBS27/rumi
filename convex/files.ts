import { ConvexError, v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { roomSchema } from "../shared/contracts";
import { replaceRoom } from "./projects";
import {
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./ownership";
import { hashToken, randomToken } from "../shared/capture/pairing";
import { boundedBody } from "../shared/network/policy";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from "../shared/files";
import type { Id } from "./_generated/dataModel";

export const begin = mutation({
  args: {
    projectId: v.id("projects"),
    kind: v.union(v.literal("workspace"), v.literal("scan")),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(args.projectId);
    if (project?.ownerId !== ownerId) throw new Error("Project not found.");
    if (
      !Number.isSafeInteger(args.size) ||
      args.size < 1 ||
      args.size > MAX_FILE_BYTES
    )
      throw new Error("Invalid file size.");
    const token = randomToken();
    const fileId = await ctx.db.insert("files", {
      ...args,
      ownerId,
      chunks: [],
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + 3600000,
      complete: false,
    });
    await ctx.scheduler.runAfter(3600000, internal.files.expire, { fileId });
    return {
      fileId,
      token,
      url: `${process.env.CONVEX_SITE_URL}/files/upload`,
    };
  },
});
export const uploadState = internalQuery({
  args: { fileId: v.id("files"), tokenHash: v.string() },
  handler: async (ctx, { fileId, tokenHash }) => {
    const file = await ctx.db.get(fileId);
    if (
      !file ||
      file.tokenHash !== tokenHash ||
      file.expiresAt < Date.now() ||
      (await ctx.db
        .query("accountDeletions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", file.ownerId))
        .unique()) ||
      !(await ctx.db.get(file.projectId))
    )
      return null;
    return file;
  },
});
export const append = internalMutation({
  args: {
    fileId: v.id("files"),
    tokenHash: v.string(),
    index: v.number(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { fileId, tokenHash, index, storageId }) => {
    const file = await ctx.db.get(fileId);
    if (
      !file ||
      file.tokenHash !== tokenHash ||
      file.expiresAt < Date.now() ||
      (await ctx.db
        .query("accountDeletions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", file.ownerId))
        .unique()) ||
      !(await ctx.db.get(file.projectId))
    )
      throw new Error("Upload expired.");
    if (index < file.chunks.length) {
      const [old, incoming] = await Promise.all([
        ctx.db.system.get(file.chunks[index]),
        ctx.db.system.get(storageId),
      ]);
      if (old?.sha256 !== incoming?.sha256)
        throw new Error(
          "This chunk was already uploaded with different content.",
        );
      await ctx.storage.delete(storageId);
      return;
    }
    if (file.complete) throw new Error("File is already complete.");
    if (index !== file.chunks.length)
      throw new Error("Upload chunks in order.");
    const metadata = await ctx.db.system.get(storageId);
    const remaining = file.size - index * FILE_CHUNK_BYTES;
    if (!metadata || metadata.size !== Math.min(FILE_CHUNK_BYTES, remaining))
      throw new Error("Invalid chunk size.");
    const chunks = [...file.chunks, storageId];
    const complete = chunks.length === Math.ceil(file.size / FILE_CHUNK_BYTES);
    await ctx.db.patch(fileId, { chunks, complete });
  },
});
const scanIntent = v.union(
  // Reuse the published scan; only valid for the same room and recorded scan.
  v.object({ action: v.literal("keep"), scanId: v.string() }),
  v.object({
    action: v.literal("replace"),
    fileId: v.id("files"),
    scanId: v.string(),
  }),
  // The new source deliberately has no scan.
  v.object({ action: v.literal("remove") }),
);

/**
 * Commit a room's source files, and optionally the room itself, in one
 * transaction after every chunk has uploaded. A failed or conflicting publish
 * leaves the previous room and source pair untouched.
 */
export const publish = mutation({
  args: {
    projectId: v.id("projects"),
    workspaceFileId: v.id("files"),
    roomId: v.optional(v.string()),
    scan: v.optional(scanIntent),
    // Older clients name a replacement scan directly and omit everything else.
    scanFileId: v.optional(v.id("files")),
    room: v.optional(zodToConvex(roomSchema)),
    expectedRevision: v.optional(v.union(v.number(), v.null())),
    expectedGeneration: v.optional(v.number()),
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(args.projectId);
    if (project?.ownerId !== ownerId) throw new Error("Project not found.");
    const generation = project.sourceGeneration ?? 0;
    if (
      args.expectedGeneration !== undefined &&
      args.expectedGeneration !== generation
    )
      throw new Error(
        "This project's saved source changed in another tab. Reload before saving.",
      );
    if (args.scan && args.scanFileId) throw new Error("Name the scan once.");
    const roomId = args.room?.id ?? args.roomId;
    if (args.room) {
      if (args.expectedRevision === undefined)
        throw new Error("Replacing a room requires its expected revision.");
      if (args.roomId !== undefined && args.roomId !== args.room.id)
        throw new Error("The source belongs to another room.");
      await replaceRoom(ctx, project, args.room, args.expectedRevision);
    } else if (
      roomId &&
      (!project.roomId ||
        (await ctx.db.get(project.roomId))?.snapshot.id !== roomId)
    )
      throw new Error(
        "The room changed during upload. Import the source again.",
      );
    const sameRoom =
      project.sourceRoomId === undefined || project.sourceRoomId === roomId;
    let scanFileId: Id<"files"> | undefined;
    let sourceScanId: string | undefined;
    if (args.scan?.action === "replace") {
      scanFileId = args.scan.fileId;
      sourceScanId = args.scan.scanId;
    } else if (args.scanFileId) scanFileId = args.scanFileId;
    else if (args.scan?.action === "keep") {
      if (
        !project.scanFileId ||
        project.sourceRoomId !== roomId ||
        project.sourceScanId !== args.scan.scanId
      )
        throw new Error(
          "The saved scan does not match this room. Upload it again.",
        );
      scanFileId = project.scanFileId;
      sourceScanId = project.sourceScanId;
    } else if (!args.scan && project.scanFileId && sameRoom)
      // Missing local data must not downgrade a saved scan for this room.
      throw new ConvexError({
        code: "SCAN_WOULD_BE_LOST",
        message:
          "This room already has a saved scan. Re-import its ZIP, or remove the scan explicitly.",
      });
    for (const [id, kind] of [
      [args.workspaceFileId, "workspace"],
      [scanFileId, "scan"],
    ] as const) {
      if (!id) continue;
      const file = await ctx.db.get(id);
      if (
        !file?.complete ||
        file.projectId !== args.projectId ||
        file.ownerId !== ownerId ||
        file.kind !== kind
      )
        throw new Error("The source upload is incomplete.");
      if (
        file.expiresAt < Date.now() &&
        project.workspaceFileId !== id &&
        project.scanFileId !== id
      )
        throw new Error("The source upload expired. Retry the upload.");
    }
    await ctx.db.patch(args.projectId, {
      workspaceFileId: args.workspaceFileId,
      scanFileId,
      sourceRoomId: roomId,
      sourceScanId,
      sourceGeneration: generation + 1,
    });
    for (const old of [project.workspaceFileId, project.scanFileId])
      if (old && old !== args.workspaceFileId && old !== scanFileId)
        await ctx.scheduler.runAfter(0, internal.files.remove, { fileId: old });
    return { generation: generation + 1 };
  },
});
export const remove = internalMutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) return;
    const project = await ctx.db.get(file.projectId);
    if (project?.workspaceFileId === fileId || project?.scanFileId === fileId)
      return;
    for (const chunk of file.chunks) await ctx.storage.delete(chunk);
    await ctx.db.delete(fileId);
  },
});
export const expire = internalMutation({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (file) await ctx.runMutation(internal.files.remove, { fileId });
  },
});
export const ticket = mutation({
  args: {
    projectId: v.id("projects"),
    kind: v.optional(v.union(v.literal("workspace"), v.literal("scan"))),
    imageId: v.optional(v.id("images")),
  },
  handler: async (ctx, { projectId, kind, imageId }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (project?.ownerId !== ownerId) throw new Error("Project not found.");
    const fileId =
      kind === "scan"
        ? project.scanFileId
        : kind === "workspace"
          ? project.workspaceFileId
          : undefined;
    if (imageId) {
      const image = await ctx.db.get(imageId);
      if (image?.projectId !== projectId) throw new Error("Image not found.");
    } else if (!fileId) return null;
    const file = fileId ? await ctx.db.get(fileId) : null;
    if (fileId && !file?.complete) return null;
    const token = randomToken();
    const id = await ctx.db.insert("fileTickets", {
      ownerId,
      projectId,
      fileId,
      imageId,
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + 300000,
    });
    await ctx.scheduler.runAfter(300000, internal.files.expireTicket, { id });
    return {
      url: `${process.env.CONVEX_SITE_URL}/files/download?token=${token}`,
      size: file?.size ?? 0,
      chunks: file?.chunks.length ?? 1,
    };
  },
});
export const expireTicket = internalMutation({
  args: { id: v.id("fileTickets") },
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});
export const resolve = internalQuery({
  args: { tokenHash: v.string(), index: v.number() },
  handler: async (ctx, { tokenHash, index }) => {
    const ticket = await ctx.db
      .query("fileTickets")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!ticket || ticket.expiresAt < Date.now()) return null;
    if (
      await ctx.db
        .query("accountDeletions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ticket.ownerId))
        .unique()
    )
      return null;
    if (ticket.projectId && !(await ctx.db.get(ticket.projectId))) return null;
    if (ticket.captureId) {
      const capture = await ctx.db.get(ticket.captureId);
      if (
        !capture?.storageId ||
        capture.ownerId !== ticket.ownerId ||
        capture.state !== "uploaded"
      )
        return null;
      if (capture.format === "zip") {
        const chunk = await ctx.db
          .query("captureChunks")
          .withIndex("by_capture_index", (q) =>
            q.eq("captureId", capture._id).eq("index", index),
          )
          .unique();
        return chunk
          ? {
              storageId: chunk.storageId,
              contentType: "application/octet-stream",
            }
          : null;
      }
      return index === 0
        ? { storageId: capture.storageId, contentType: "application/json" }
        : null;
    }
    if (ticket.imageId) {
      const image = await ctx.db.get(ticket.imageId);
      return image && index === 0
        ? { storageId: image.storageId, contentType: image.contentType }
        : null;
    }
    const file = ticket.fileId && (await ctx.db.get(ticket.fileId));
    return file && file.chunks[index]
      ? {
          storageId: file.chunks[index],
          contentType: "application/octet-stream",
        }
      : null;
  },
});
function cors(request: Request) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
  });
  const origin = request.headers.get("origin");
  if (
    origin &&
    (process.env.CHAT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(origin)
  )
    headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return headers;
}
export const options = httpAction(
  async (_ctx, request) =>
    new Response(null, { status: 204, headers: cors(request) }),
);
export const upload = httpAction(async (ctx, request) => {
  const headers = cors(request);
  let storageId: Id<"_storage"> | undefined;
  try {
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId") as Id<"files">;
    const index = Number(url.searchParams.get("index"));
    const token =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const tokenHash = await hashToken(token);
    const state = await ctx.runQuery(internal.files.uploadState, {
      fileId,
      tokenHash,
    });
    if (!state || !Number.isSafeInteger(index) || index < 0)
      return new Response("Upload expired", { status: 403, headers });
    const bytes = await boundedBody(
      new Response(request.body, { headers: request.headers }),
      FILE_CHUNK_BYTES,
    );
    storageId = await ctx.storage.store(
      new Blob([bytes], { type: `application/x-rumi-file-${fileId}` }),
    );
    await ctx.runMutation(internal.files.append, {
      fileId,
      index,
      tokenHash,
      storageId,
    });
    return new Response(null, { status: 204, headers });
  } catch {
    if (storageId) await ctx.storage.delete(storageId);
    return new Response("Upload failed", { status: 400, headers });
  }
});
export const download = httpAction(async (ctx, request) => {
  const headers = cors(request);
  const url = new URL(request.url);
  const index = Number(url.searchParams.get("index") ?? "0");
  if (!Number.isSafeInteger(index) || index < 0)
    return new Response(null, { status: 400, headers });
  const file = await ctx.runQuery(internal.files.resolve, {
    tokenHash: await hashToken(url.searchParams.get("token") ?? ""),
    index,
  });
  if (!file) return new Response(null, { status: 404, headers });
  const blob = await ctx.storage.get(file.storageId);
  if (!blob) return new Response(null, { status: 404, headers });
  headers.set("Content-Type", file.contentType);
  return new Response(blob, { headers });
});

export const captureTicket = mutation({
  args: { captureId: v.id("captures") },
  handler: async (ctx, { captureId }) => {
    const ownerId = await requireOwner(ctx);
    const capture = await ctx.db.get(captureId);
    if (
      capture?.ownerId !== ownerId ||
      capture.state !== "uploaded" ||
      !capture.storageId
    )
      throw new Error("Capture not found.");
    const file = await ctx.db.system.get(capture.storageId);
    if (!file) throw new Error("Capture file not found.");
    const expectedChunks =
      capture.format === "zip" ? Math.ceil(file.size / FILE_CHUNK_BYTES) : 1;
    const existingChunks =
      capture.format === "zip"
        ? await ctx.db
            .query("captureChunks")
            .withIndex("by_capture_index", (q) => q.eq("captureId", captureId))
            .collect()
        : [];
    const ready =
      capture.format !== "zip" || existingChunks.length === expectedChunks;
    if (!ready)
      await ctx.scheduler.runAfter(
        0,
        internal.capturePackages.prepareDownload,
        { sessionId: captureId },
      );
    const token = randomToken();
    const id = await ctx.db.insert("fileTickets", {
      ownerId,
      captureId,
      tokenHash: await hashToken(token),
      expiresAt: Date.now() + 300000,
    });
    await ctx.scheduler.runAfter(300000, internal.files.expireTicket, { id });
    return {
      url: `${process.env.CONVEX_SITE_URL}/files/download?token=${token}`,
      ready,
      size: file.size,
      chunks:
        capture.format === "zip" ? Math.ceil(file.size / FILE_CHUNK_BYTES) : 1,
    };
  },
});
