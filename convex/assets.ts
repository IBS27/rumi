import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  assetSchema,
  type AssetRecord,
  type ProductCandidate,
} from "../shared/contracts";

export const upsertAsset = internalMutation({
  returns: v.string(),
  args: { asset: zodToConvex(assetSchema) },
  handler: async (ctx, args): Promise<string> => {
    const asset = assetSchema.parse(args.asset);
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", asset.id))
      .unique();
    if (existing) await ctx.db.replace(existing._id, asset);
    else await ctx.db.insert("assets", asset);
    return asset.id;
  },
});

export const getByCatalogId = internalQuery({
  returns: v.union(v.null(), zodToConvex(assetSchema)),
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<AssetRecord | null> => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", id))
      .unique();
    return asset ? assetSchema.parse(asset) : null;
  },
});

export async function queueProductAsset(
  ctx: MutationCtx,
  product: ProductCandidate,
  retry = false,
) {
  const id = product.assetId ?? `${product.id}-asset`;
  const existing = await ctx.db
    .query("assets")
    .withIndex("by_catalog_id", (q) => q.eq("id", id))
    .unique();
  if (existing?.status === "ready" || (existing?.status === "failed" && !retry))
    return;
  if (
    existing?.status === "pending" &&
    Date.now() - (existing.updatedAt ?? 0) < 300000
  )
    return;
  const attempt = (existing?.attempt ?? 0) + 1;
  const unavailable =
    !product.measurement.dimensions ||
    !product.images.length ||
    product.synthetic;
  const asset = assetSchema.parse({
    id,
    status: unavailable ? "failed" : "pending",
    url: null,
    accuracy: "approximate",
    scale: 1,
    rotation: { x: 0, y: 0, z: 0 },
    attempt,
    updatedAt: Date.now(),
    ...(unavailable
      ? {
          error: product.synthetic
            ? "Sample product shown as a size preview."
            : "Product photos and dimensions are required for a model.",
        }
      : {}),
  });
  if (existing) await ctx.db.replace(existing._id, asset);
  else await ctx.db.insert("assets", asset);
  const stored = await ctx.db
    .query("products")
    .withIndex("by_catalog_id", (q) => q.eq("id", product.id))
    .unique();
  if (stored && (!stored.assetId || stored.assetId === id))
    await ctx.db.patch(stored._id, { assetId: id });
  if (!unavailable) {
    await ctx.scheduler.runAfter(0, internal.assetJobs.generateForProduct, {
      productId: product.id,
      productSnapshot: product,
      attempt,
    });
    await ctx.scheduler.runAfter(300000, internal.assets.expire, {
      id,
      attempt,
    });
  }
}

export const expire = internalMutation({
  args: { id: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { id, attempt }) => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", id))
      .unique();
    if (asset?.status === "pending" && asset.attempt === attempt)
      await ctx.db.patch(asset._id, {
        status: "failed",
        error:
          "Model preparation timed out. Your size preview is still available.",
        updatedAt: Date.now(),
      });
    return null;
  },
});

export const finish = internalMutation({
  args: { asset: zodToConvex(assetSchema), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { asset, attempt }) => {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", asset.id))
      .unique();
    if (existing?.attempt === attempt && existing.status === "pending")
      await ctx.db.replace(existing._id, assetSchema.parse(asset));
    return null;
  },
});
