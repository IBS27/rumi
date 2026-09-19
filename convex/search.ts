import { openai } from "@ai-sdk/openai";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { searchTaskSchema, type SearchTaskResult } from "../shared/contracts";
import { exaContents, exaSearch } from "../shared/search";
import { fetchPage } from "../shared/search/page";
import { runSearch } from "../shared/search/pipeline";
import { extractListing, readDiagram } from "./extract";

// The deployment side of the search agent: keys, models, storage. The pipeline itself
// lives in shared/search so it can be tested without a deployment.
export const searchProducts = internalAction({
  args: { task: zodToConvex(searchTaskSchema) },
  handler: async (ctx, args): Promise<SearchTaskResult> => {
    const task = searchTaskSchema.parse(args.task);
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey)
      throw new Error("Set EXA_API_KEY in this deployment's environment.");
    const listingModel = openai(
      process.env.RUMI_EXTRACTION_MODEL ?? "gpt-4o-mini",
    );
    const visionModel = openai(process.env.RUMI_VISION_MODEL ?? "gpt-4o");
    return await runSearch(task, {
      search: (query, numResults, includeDomains) =>
        exaSearch(apiKey, query, numResults, includeDomains),
      fetchPage: (url) => fetchPage(url),
      fetchContents: (urls) => exaContents(apiKey, urls),
      fetchJson: async (url) => {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
        });
        if (!response.ok)
          throw new Error(`${url} answered with status ${response.status}.`);
        return await response.json();
      },
      extractListing: (page, current) =>
        extractListing(listingModel, page, current),
      readDiagram: (images) => readDiagram(visionModel, images),
      persist: async (products) => {
        await ctx.runMutation(internal.products.upsertProducts, { products });
      },
    });
  },
});
