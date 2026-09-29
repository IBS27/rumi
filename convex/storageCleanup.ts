import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
export const sweep = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - 3600000),
      )
      .paginate({ cursor: cursor ?? null, numItems: 100 });
    for (const blob of page.page) {
      if (blob.contentType === "application/x-rumi-public-cache") {
        const cached = await ctx.db
          .query("sourceCache")
          .withIndex("by_storageId", (q) => q.eq("storageId", blob._id))
          .unique();
        if (!cached) await ctx.storage.delete(blob._id);
      }
      const captureKey = blob.contentType?.match(
        /^application\/x-rumi-capture-(.+)$/,
      )?.[1];
      if (captureKey) {
        const captureId = ctx.db.normalizeId("captures", captureKey);
        const chunks = captureId
          ? await ctx.db
              .query("captureChunks")
              .withIndex("by_capture_index", (q) =>
                q.eq("captureId", captureId),
              )
              .collect()
          : [];
        if (!chunks.some((chunk) => chunk.storageId === blob._id))
          await ctx.storage.delete(blob._id);
      }
      const key = blob.contentType?.match(
        /^application\/x-rumi-file-(.+)$/,
      )?.[1];
      if (!key) continue;
      const id = ctx.db.normalizeId("files", key);
      const file = id && (await ctx.db.get(id));
      if (!file || !file.chunks.includes(blob._id))
        await ctx.storage.delete(blob._id);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.storageCleanup.sweep, {
        cursor: page.continueCursor,
      });
  },
});
