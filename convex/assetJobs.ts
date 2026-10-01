"use node";
import { openai } from "@ai-sdk/openai";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  assetSchema,
  productSchema,
  type AssetRecord,
  type ProductCandidate,
} from "../shared/contracts";
import { generateParametricModel } from "./assetGeneration";
import { safeFetch } from "../shared/network/server";
export const DEFAULT_ASSET_MODEL = "gpt-6-astra";
// Search completes before this action starts. Asset generation is deliberately a
// separate job because Astra is slower and more expensive than product retrieval.
export const generateForProduct = internalAction({
  args: {
    productId: v.string(),
    productSnapshot: v.optional(zodToConvex(productSchema)),
    attempt: v.optional(v.number()),
  },
  returns: zodToConvex(assetSchema),
  handler: async (
    ctx,
    { productId, attempt, productSnapshot },
  ): Promise<AssetRecord> => {
    const products = (await ctx.runQuery(internal.products.getByIds, {
      ids: [productId],
    })) as ProductCandidate[];
    const product = productSnapshot ?? products[0];
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

    const id = product.assetId ?? `${product.id}-asset`;
    const cached = await ctx.runQuery(internal.assets.getByCatalogId, { id });
    if (cached?.status === "ready") return cached;
    let asset: AssetRecord;
    try {
      const scene = await generateParametricModel(
        openai(process.env.RUMI_ASSET_MODEL ?? DEFAULT_ASSET_MODEL),
        {
          name: product.name,
          category: product.category,
          dimensions,
          imageUrls: product.images,
        },
        safeFetch,
      );
      asset = assetSchema.parse({
        id,
        status: "ready",
        url: null,
        accuracy: "approximate",
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
        scene,
        attempt,
        updatedAt: Date.now(),
      });
    } catch (cause) {
      console.error(
        "Product model generation failed",
        product.id,
        cause instanceof Error
          ? cause.message.slice(0, 500)
          : "Unknown generation error",
      );
      asset = assetSchema.parse({
        id,
        status: "failed",
        url: null,
        accuracy: "approximate",
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
        attempt,
        updatedAt: Date.now(),
        error:
          "The product model could not be prepared. Retry or continue with the size preview.",
      });
    }
    if (attempt !== undefined)
      await ctx.runMutation(internal.assets.finish, { asset, attempt });
    else {
      await ctx.runMutation(internal.assets.upsertAsset, { asset });
      await ctx.runMutation(internal.products.attachAsset, {
        productId: product.id,
        assetId: asset.id,
      });
    }
    return asset;
  },
});
