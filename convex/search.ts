import { openai } from "@ai-sdk/openai";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  searchTaskSchema,
  type ProductCandidate,
  type SearchFailure,
  type SearchTaskResult,
} from "../shared/contracts";
import {
  buildExaQuery,
  dedupeProducts,
  exaContents,
  exaSearch,
  filterCandidates,
  taskResult,
} from "../shared/search";
import { extractProduct } from "./extract";

const RESULTS_PER_TASK = 8;

export const searchProducts = internalAction({
  args: { task: zodToConvex(searchTaskSchema) },
  handler: async (ctx, args): Promise<SearchTaskResult> => {
    const task = searchTaskSchema.parse(args.task);
    const failures: SearchFailure[] = [];
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey)
      throw new Error("Set EXA_API_KEY in this deployment's environment.");
    const hits = await exaSearch(apiKey, buildExaQuery(task), RESULTS_PER_TASK);
    if (hits.length === 0)
      return taskResult({
        products: [],
        explanation: `No product pages matched the search for ${task.category}.`,
        failures: [{ stage: "search", detail: "Exa returned no results." }],
      });
    const pages = await exaContents(
      apiKey,
      hits.map((hit) => hit.url),
    );
    if (pages.length === 0)
      failures.push({
        stage: "search",
        detail: "Exa returned results but no page content.",
      });
    const model = openai(process.env.RUMI_EXTRACTION_MODEL ?? "gpt-4o-mini");
    const extracted = await Promise.all(
      pages.map(async (page) => {
        try {
          return await extractProduct(model, page, task);
        } catch (error) {
          failures.push({
            stage: "extract",
            detail: `Extraction failed for ${page.url}: ${error instanceof Error ? error.message : "unknown error"}.`,
          });
          return null;
        }
      }),
    );
    const candidates = dedupeProducts(
      extracted.filter(
        (product): product is ProductCandidate => product !== null,
      ),
    );
    if (pages.length > 0 && candidates.length === 0)
      failures.push({
        stage: "extract",
        detail: "No page produced a valid product.",
      });
    const { kept, failures: filterFailures } = filterCandidates(
      candidates,
      task,
    );
    if (kept.length > 0)
      await ctx.runMutation(internal.products.upsertProducts, {
        products: kept,
      });
    return taskResult({
      products: kept,
      explanation: `Searched the web for ${task.category} and kept ${kept.length} of ${candidates.length} extracted product(s) within the price and footprint ceilings.`,
      failures: [...failures, ...filterFailures],
    });
  },
});
