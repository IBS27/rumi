import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalMutation, internalQuery } from "./_generated/server";
import { productSchema, type ProductCandidate } from "../shared/contracts";

export const upsertProducts = internalMutation({
  args: { products: v.array(zodToConvex(productSchema)) },
  handler: async (ctx, args): Promise<string[]> => {
    const inserted: string[] = [];
    for (const input of args.products) {
      const product = productSchema.parse(input);
      const existing = await ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", product.id))
        .unique();
      // Prices and stock move, so a second sighting replaces the stored record.
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
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<ProductCandidate[]> => {
    const found: ProductCandidate[] = [];
    for (const id of ids) {
      const doc = await ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", id))
        .unique();
      if (doc) found.push(doc);
    }
    return found;
  },
});
