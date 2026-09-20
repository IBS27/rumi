"use node";

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
    await ctx.runMutation(internal.captures.complete, {
      ...args,
      storageId: attached.storageId,
      digest: attached.digest,
      format: "zip",
    });
    return "uploaded" as const;
  },
});
