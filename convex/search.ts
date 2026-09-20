import { openai } from "@ai-sdk/openai";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import {
  searchTaskResultSchema,
  searchTaskSchema,
  type SearchTaskResult,
} from "../shared/contracts";
import { exaContents, exaSearch } from "../shared/search";
import {
  fetchPage,
  validateProductUrl,
} from "../shared/search/page";
import { runSearch, runSearches } from "../shared/search/pipeline";
import { extractListing, readDiagram } from "./extract";
import type { ProductCandidate, SearchTask } from "../shared/contracts";
import type { PageContent } from "../shared/search/page";
import type { ImageRef } from "../shared/search/images";

export const DEFAULT_MODEL = "gpt-5.6-luna";

// The deployment side of the search agent: keys, models, storage. The pipeline itself
// lives in shared/search so it can be tested without a deployment.
// Takes the one thing it needs from the action context, so it does not have to restate
// Convex's own types.
function searchDeps(persist: (products: ProductCandidate[]) => Promise<void>) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey)
    throw new Error("Set EXA_API_KEY in this deployment's environment.");
  // Reading a listing and reading a drawing are both small, well-scoped jobs, so both
  // run on the house default for those. Override per deployment when a job needs more.
  const listingModel = openai(
    process.env.RUMI_EXTRACTION_MODEL ?? DEFAULT_MODEL,
  );
  const visionModel = openai(process.env.RUMI_VISION_MODEL ?? DEFAULT_MODEL);
  return {
    search: (query: string, numResults: number, includeDomains: string[]) =>
      exaSearch(apiKey, query, numResults, includeDomains),
    fetchPage: (url: string) => fetchPage(url),
    validateProductUrl: (url: string) => validateProductUrl(url),
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
  returns: zodToConvex(searchTaskResultSchema),
  args: { task: zodToConvex(searchTaskSchema) },
  handler: async (ctx, args): Promise<SearchTaskResult> => {
    const result = await runSearch(
      searchTaskSchema.parse(args.task),
      searchDeps(async (products) => {
        await ctx.runMutation(internal.products.upsertProducts, { products });
      }),
    );
    return { ...result, candidates: result.candidates.slice(0, 1) };
  },
});

// One call per planned room, so the main agent does not spend a tool step per category.
export const searchCategories = internalAction({
  returns: zodToConvex(z.array(searchTaskResultSchema)),
  args: { tasks: zodToConvex(z.array(searchTaskSchema).min(1).max(8)) },
  handler: async (ctx, args): Promise<SearchTaskResult[]> => {
    const results = await runSearches(
      z.array(searchTaskSchema).parse(args.tasks),
      searchDeps(async (products) => {
        await ctx.runMutation(internal.products.upsertProducts, { products });
      }),
    );
    return results.map((result) => ({
      ...result,
      candidates: result.candidates.slice(0, 1),
    }));
  },
});
