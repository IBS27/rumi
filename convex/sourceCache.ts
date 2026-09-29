import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
export const acquire = internalMutation({
  args: { key: v.string(), token: v.string() },
  handler: async (ctx, { key, token }) => {
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (
      row?.storageId &&
      row.expiresAt > Date.now() &&
      (await ctx.db.system.get(row.storageId))
    )
      return { storageId: row.storageId, acquired: false };
    if (row && row.leaseUntil > Date.now()) return { acquired: false };
    const leaseUntil = Date.now() + 20000;
    if (row) await ctx.db.patch(row._id, { token, leaseUntil });
    else
      await ctx.db.insert("sourceCache", {
        key,
        token,
        leaseUntil,
        expiresAt: 0,
      });
    return { acquired: true };
  },
});
export const finish = internalMutation({
  args: {
    key: v.string(),
    token: v.string(),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, { key, token, storageId }) => {
    const row = await ctx.db
      .query("sourceCache")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row || row.token !== token) {
      if (storageId) await ctx.storage.delete(storageId);
      return;
    }
    if (storageId) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.patch(row._id, {
        storageId,
        expiresAt: Date.now() + 300000,
        leaseUntil: 0,
      });
    } else await ctx.db.patch(row._id, { leaseUntil: 0 });
  },
});
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("sourceCache")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now() - 86400000))
      .take(100);
    for (const row of rows) {
      if (row.leaseUntil > Date.now()) continue;
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
  },
});
