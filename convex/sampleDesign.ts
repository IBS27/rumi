import type { MutationCtx } from "./_generated/server";
import { sampleProducts } from "../shared/fixtures";
import { sampleDesignAssets } from "../shared/fixtures/design";

/** Only trusted, visibly synthetic fixtures are seeded, never client catalog data. */
export async function ensureSampleDesign(ctx: MutationCtx) {
  for (const product of sampleProducts) {
    const existing = await ctx.db
      .query("products")
      .withIndex("by_catalog_id", (q) => q.eq("id", product.id))
      .unique();
    if (!existing) await ctx.db.insert("products", product);
  }
  for (const asset of sampleDesignAssets) {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", asset.id))
      .unique();
    if (!existing || existing.status !== "ready") {
      if (existing) await ctx.db.replace(existing._id, asset);
      else await ctx.db.insert("assets", asset);
    }
  }
}
