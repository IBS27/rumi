"use node";
import { FILE_CHUNK_BYTES } from "../shared/files";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MAX_SCAN_BYTES } from "../shared/capture/pairing";
import { readPackage } from "../shared/capture/package";

// ZIP validation needs the Node runtime's memory budget. Large files never pass
// through HTTP action bodies or function arguments.
export const accept = internalAction({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    idempotencyKey: v.string(),
    storageId: v.string(),
  },
  returns: v.union(v.literal("uploaded"), v.literal("invalid")),
  handler: async (ctx, args) => {
    const attached = await ctx.runMutation(
      internal.captures.attachScanUpload,
      args,
    );
    if (attached.uploaded) return "uploaded" as const;
    const blob = await ctx.storage.get(attached.storageId);
    if (!blob || blob.size > MAX_SCAN_BYTES) return "invalid" as const;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      readPackage(bytes);
    } catch {
      return "invalid" as const;
    }
    for (let index = 0; index * FILE_CHUNK_BYTES < blob.size; index++) {
      const storageId = await ctx.storage.store(
        blob.slice(
          index * FILE_CHUNK_BYTES,
          (index + 1) * FILE_CHUNK_BYTES,
          `application/x-rumi-capture-${args.sessionId}`,
        ),
      );
      try {
        await ctx.runMutation(internal.captures.storeChunk, {
          sessionId: args.sessionId,
          uploadHash: args.uploadHash,
          index,
          storageId,
        });
      } catch (error) {
        await ctx.storage.delete(storageId);
        throw error;
      }
    }
    await ctx.runMutation(internal.captures.complete, {
      ...args,
      storageId: attached.storageId,
      digest: attached.digest,
      format: "zip",
    });
    return "uploaded" as const;
  },
});

// Accepted transfers from the previous release gain private chunks on demand.
export const prepareDownload = internalAction({
  args: { sessionId: v.id("captures") },
  handler: async (ctx, { sessionId }) => {
    const source = await ctx.runQuery(internal.captures.downloadSource, {
      sessionId,
    });
    if (!source) return;
    const blob = await ctx.storage.get(source.storageId);
    if (!blob || blob.size > MAX_SCAN_BYTES) return;
    for (let index = 0; index * FILE_CHUNK_BYTES < blob.size; index++) {
      const storageId = await ctx.storage.store(
        blob.slice(
          index * FILE_CHUNK_BYTES,
          (index + 1) * FILE_CHUNK_BYTES,
          `application/x-rumi-capture-${sessionId}`,
        ),
      );
      try {
        await ctx.runMutation(internal.captures.storeChunk, {
          sessionId,
          uploadHash: source.uploadHash,
          index,
          storageId,
        });
      } catch (error) {
        await ctx.storage.delete(storageId);
        throw error;
      }
    }
  },
});
