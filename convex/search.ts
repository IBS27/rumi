import { openai } from "@ai-sdk/openai";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import { searchTaskSchema, type SearchTaskResult } from "../shared/contracts";
import { exaContents, exaSearch } from "../shared/search";
import { fetchPage } from "../shared/search/page";
import { runSearch, runSearches } from "../shared/search/pipeline";
import { extractListing, readDiagram } from "./extract";
import type { ProductCandidate, SearchTask } from "../shared/contracts";
import type { PageContent } from "../shared/search/page";
import type { ImageRef } from "../shared/search/images";

// The deployment side of the search agent: keys, models, storage. The pipeline itself
// lives in shared/search so it can be tested without a deployment.
// Takes the one thing it needs from the action context, so it does not have to restate
// Convex's own types.
function searchDeps(persist: (products: ProductCandidate[]) => Promise<void>) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey)
    throw new Error("Set EXA_API_KEY in this deployment's environment.");
  const listingModel = openai(
    process.env.RUMI_EXTRACTION_MODEL ?? "gpt-4o-mini",
  );
  const visionModel = openai(process.env.RUMI_VISION_MODEL ?? "gpt-4o");
  return {
    search: (query: string, numResults: number, includeDomains: string[]) =>
      exaSearch(apiKey, query, numResults, includeDomains),
    fetchPage: (url: string) => fetchPage(url),
    fetchContents: (urls: string[]) => exaContents(apiKey, urls),
    fetchJson: async (url: string) => {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok)
        throw new Error(`${url} answered with status ${response.status}.`);
      return await response.json();
    },
    extractListing: (page: PageContent, task: SearchTask) =>
      extractListing(listingModel, page, task),
    readDiagram: (images: ImageRef[]) => readDiagram(visionModel, images),
    persist,
  };
}

export const searchProducts = internalAction({
  args: { task: zodToConvex(searchTaskSchema) },
  handler: async (ctx, args): Promise<SearchTaskResult> =>
    await runSearch(
      searchTaskSchema.parse(args.task),
      searchDeps(async (products) => {
        await ctx.runMutation(internal.products.upsertProducts, { products });
      }),
    ),
});

// One call per planned room, so the main agent does not spend a tool step per category.
export const searchCategories = internalAction({
  args: { tasks: zodToConvex(z.array(searchTaskSchema).min(1).max(8)) },
  handler: async (ctx, args): Promise<SearchTaskResult[]> =>
    await runSearches(
      z.array(searchTaskSchema).parse(args.tasks),
      searchDeps(async (products) => {
        await ctx.runMutation(internal.products.upsertProducts, { products });
      }),
    ),
});
