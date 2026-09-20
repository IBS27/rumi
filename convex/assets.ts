import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  assetSchema,
  type AssetRecord,
  type ProductCandidate,
} from "../shared/contracts";
import { generateParametricModel } from "./assetGeneration";

export const DEFAULT_ASSET_MODEL = "gpt-6-astra";

export const upsertAsset = internalMutation({
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
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<AssetRecord | null> => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_catalog_id", (q) => q.eq("id", id))
      .unique();
    return asset ? assetSchema.parse(asset) : null;
  },
});

// Search completes before this action starts. Asset generation is deliberately a
// separate job because Astra is slower and more expensive than product retrieval.
export const generateForProduct = internalAction({
  args: { productId: v.string() },
  handler: async (ctx, { productId }): Promise<AssetRecord> => {
    const products = (await ctx.runQuery(internal.products.getByIds, {
      ids: [productId],
    })) as ProductCandidate[];
    const product = products[0];
    if (!product) throw new Error(`No product exists for ${productId}.`);
    const dimensions = product.measurement.dimensions;
    if (!dimensions)
      throw new Error(
        "Resolved product dimensions are required before 3D generation.",
      );
    if (product.images.length === 0)
      throw new Error(
        "At least one product photo is required for 3D generation.",
      );

    const scene = await generateParametricModel(
      openai(process.env.RUMI_ASSET_MODEL ?? DEFAULT_ASSET_MODEL),
      {
        name: product.name,
        category: product.category,
        dimensions,
        imageUrls: product.images,
      },
    );
    const asset = assetSchema.parse({
      id: `${product.id}-asset`,
      status: "ready",
      url: null,
      accuracy: "approximate",
      scale: 1,
      rotation: { x: 0, y: 0, z: 0 },
      scene,
    });
    await ctx.runMutation(internal.assets.upsertAsset, { asset });
    await ctx.runMutation(internal.products.attachAsset, {
      productId: product.id,
      assetId: asset.id,
    });
    return asset;
  },
});
