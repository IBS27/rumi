import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalMutation, internalQuery } from "./_generated/server";
import { productSchema, type ProductCandidate } from "../shared/contracts";

export const upsertProducts = internalMutation({
  returns: v.array(v.string()),
  args: { products: v.array(zodToConvex(productSchema)) },
  handler: async (ctx, args): Promise<string[]> => {
    const inserted: string[] = [];
    for (const input of args.products) {
      const product = productSchema.parse(input);
      const existing = await ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", product.id))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, product);
        continue;
      }
      await ctx.db.insert("products", product);
      inserted.push(product.id);
    }
    return inserted;
  },
});

export const getByIds = internalQuery({
  returns: v.array(zodToConvex(productSchema)),
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<ProductCandidate[]> => {
    const found: ProductCandidate[] = [];
    for (const id of ids) {
      const doc = await ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", id))
        .unique();
      if (doc) found.push(productSchema.parse(doc));
    }
    return found;
  },
});

export const attachAsset = internalMutation({
  args: { productId: v.string(), assetId: v.string() },
  handler: async (ctx, { productId, assetId }): Promise<boolean> => {
    const existing = await ctx.db
      .query("products")
      .withIndex("by_catalog_id", (q) => q.eq("id", productId))
      .unique();
    if (!existing) return false;
    const product = productSchema.parse({ ...existing, assetId });
    await ctx.db.replace(existing._id, product);
    return true;
  },
});
