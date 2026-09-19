import type {
  ProductCandidate,
  SearchFailure,
  SearchTask,
  SearchTaskResult,
} from "../contracts";
import { buildCandidate, pickFacts, type ListingFacts } from "./candidate";
import { resolveDimensions, type DiagramReader } from "./cascade";
import { relevantImages, type ImageRef } from "./images";
import { parseProductJsonLd } from "./jsonld";
import { factsFromJsonLd, factsFromShopify } from "./listing";
import type { PageContent } from "./page";
import { rankCandidates } from "./rank";
import { isShopify, mapShopifyProduct, productJsonUrl } from "./shopify";
import { tierFor } from "./retailers";
import {
  buildExaQuery,
  dedupeProducts,
  filterCandidates,
  resolveToFit,
  searchDomains,
  taskResult,
  type ExaSearchHit,
} from "./index";

// One task, one category. Cheap signals filter first; the one expensive stage — reading
// a dimension drawing — runs last, on ranked survivors, until enough candidates fit.

export interface PipelineDeps {
  search: (
    query: string,
    numResults: number,
    includeDomains: string[],
  ) => Promise<ExaSearchHit[]>;
  fetchPage: (url: string) => Promise<PageContent | null>;
  /** Fallback for pages that block a direct fetch. */
  fetchContents: (urls: string[]) => Promise<PageContent[]>;
  fetchJson: (url: string) => Promise<unknown>;
  extractListing: (
    page: PageContent,
    task: SearchTask,
  ) => Promise<Partial<ListingFacts>>;
  readDiagram: DiagramReader;
  persist?: (products: ProductCandidate[]) => Promise<void>;
}

export interface PipelineOptions {
  results: number;
  minTierHits: number;
  target: number;
  maxVision: number;
  maxExtractions: number;
}

export const DEFAULTS: PipelineOptions = {
  results: 12,
  minTierHits: 6,
  target: 3,
  maxVision: 3,
  maxExtractions: 8,
};

interface PageFacts {
  productId: string;
  pageText: string;
  structuredText: string | null;
  images: ImageRef[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// Retail pages are rendered in the browser: a raw fetch returns navigation and
// promotions, while the gallery and the specification arrive later. So rendered content
// is the primary source, and the raw markup is kept only for what rendering strips —
// JSON-LD blocks and the storefront fingerprint.
async function gatherPages(
  urls: string[],
  deps: PipelineDeps,
  failures: SearchFailure[],
): Promise<PageContent[]> {
  const raw = new Map<string, PageContent>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const page = await deps.fetchPage(url);
        if (page) raw.set(url, page);
      } catch {
        // A blocked page is normal; rendered content still has a chance.
      }
    }),
  );
  let rendered: PageContent[] = [];
  try {
    rendered = await deps.fetchContents(urls);
  } catch (error) {
    failures.push({
      stage: "search",
      detail: `Page contents failed: ${message(error)}.`,
    });
  }
  const byUrl = new Map(rendered.map((page) => [page.url, page]));
  const pages: PageContent[] = [];
  for (const url of urls) {
    const markup = raw.get(url);
    const live = byUrl.get(url);
    if (!markup && !live) continue;
    pages.push({
      url,
      title: live?.title ?? markup?.title ?? null,
      html: markup?.html ?? live?.html ?? null,
      text: [live?.text, markup?.text].filter(Boolean).join("\n"),
      images: [
        ...(live?.images ?? []),
        ...(markup ? relevantImages(markup.images, url) : []),
      ],
    });
  }
  if (pages.length < urls.length)
    failures.push({
      stage: "search",
      detail: `${urls.length - pages.length} page(s) could not be read.`,
    });
  return pages;
}

async function merchantLayer(
  page: PageContent,
  task: SearchTask,
  deps: PipelineDeps,
): Promise<{
  facts: Partial<ListingFacts>;
  images: ImageRef[];
  bodyText: string;
}> {
  if (!page.html || !isShopify(page.html))
    return { facts: {}, images: [], bodyText: "" };
  const jsonUrl = productJsonUrl(page.url);
  if (!jsonUrl) return { facts: {}, images: [], bodyText: "" };
  try {
    const payload = await deps.fetchJson(jsonUrl);
    return factsFromShopify(mapShopifyProduct(payload), {
      maxPriceCents: task.maxPriceCents,
      palette: task.palette,
    });
  } catch {
    return { facts: {}, images: [], bodyText: "" };
  }
}

export async function runSearch(
  task: SearchTask,
  deps: PipelineDeps,
  options: Partial<PipelineOptions> = {},
): Promise<SearchTaskResult> {
  const settings = { ...DEFAULTS, ...options };
  const failures: SearchFailure[] = [];
  const query = buildExaQuery(task);
  const domains = searchDomains(task);

  let hits = await deps.search(query, settings.results, domains);
  if (hits.length < settings.minTierHits) {
    failures.push({
      stage: "search",
      detail: `Only ${hits.length} result(s) inside the ${tierFor(task.maxPriceCents)} tier, so the open web was searched as well.`,
    });
    const open = await deps.search(query, settings.results, []);
    const seen = new Set(hits.map((hit) => hit.url));
    hits = [...hits, ...open.filter((hit) => !seen.has(hit.url))];
  }
  if (hits.length === 0)
    return taskResult(
      task,
      [],
      [...failures, { stage: "search", detail: "No product pages matched." }],
      `No ${task.category} listings matched this search.`,
    );

  const pages = await gatherPages(
    hits.slice(0, settings.results).map((hit) => hit.url),
    deps,
    failures,
  );

  const candidates: ProductCandidate[] = [];
  const contexts = new Map<string, PageFacts>();
  let extractions = 0;
  for (const page of pages) {
    const merchant = await merchantLayer(page, task, deps);
    const jsonLd = page.html ? parseProductJsonLd(page.html) : null;
    const structured = factsFromJsonLd(jsonLd);
    const layers: Partial<ListingFacts>[] = [merchant.facts, structured];
    const missing =
      !(merchant.facts.name ?? structured.name) ||
      (merchant.facts.priceCents ?? structured.priceCents) === null ||
      (merchant.facts.priceCents ?? structured.priceCents) === undefined;
    if (missing && extractions < settings.maxExtractions) {
      extractions++;
      try {
        layers.push(await deps.extractListing(page, task));
      } catch (error) {
        failures.push({
          stage: "extract",
          detail: `Could not read ${page.url}: ${message(error)}.`,
        });
      }
    }
    // The gallery is added last: merchant and structured images already lead it.
    const pageText = [merchant.bodyText, page.text].filter(Boolean).join("\n");
    const images = [
      ...merchant.images,
      ...(jsonLd?.images ?? []).map((url) => ({ url, alt: null })),
      ...page.images,
    ];
    // The gallery is added last: merchant and structured images already lead it.
    const facts = pickFacts([
      ...layers,
      { images: images.map((image) => image.url) },
    ]);
    // Cheap stages only. A drawing is read later, and only if the ranking calls for it.
    const resolved = await resolveDimensions({
      category: task.category,
      structuredText: jsonLd?.dimensionText ?? null,
      pageText,
      images,
    });
    const { product, issue } = buildCandidate({
      sourceUrl: page.url,
      category: task.category,
      facts,
      measurement: resolved.measurement,
    });
    if (!product) {
      failures.push({
        stage: "extract",
        detail: `Skipped ${page.url}: ${issue ?? "incomplete listing"}.`,
      });
      continue;
    }
    candidates.push(product);
    contexts.set(product.id, {
      productId: product.id,
      pageText,
      structuredText: jsonLd?.dimensionText ?? null,
      images,
    });
  }

  const unique = dedupeProducts(candidates);
  const { kept, failures: filterFailures } = filterCandidates(unique, task);
  failures.push(...filterFailures);
  const ranked = rankCandidates(kept, task);

  const { kept: sized, failures: sizingFailures } = await resolveToFit({
    candidates: ranked.map((candidate) => candidate.product),
    task,
    target: settings.target,
    maxResolutions: settings.maxVision,
    resolve: async (product) => {
      const context = contexts.get(product.id);
      if (!context)
        return {
          product,
          failures: [
            {
              stage: "dimensions" as const,
              detail: `No page context for ${product.name}.`,
            },
          ],
        };
      try {
        const resolution = await resolveDimensions({
          category: task.category,
          structuredText: context.structuredText,
          pageText: context.pageText,
          images: context.images,
          readDiagram: deps.readDiagram,
        });
        return {
          product: { ...product, measurement: resolution.measurement },
          failures: resolution.failures,
        };
      } catch (error) {
        return {
          product,
          failures: [
            {
              stage: "dimensions" as const,
              detail: `Reading the drawing for ${product.name} failed: ${message(error)}.`,
            },
          ],
        };
      }
    },
  });
  failures.push(...sizingFailures);

  const finalists = rankCandidates(sized, task);
  if (deps.persist && finalists.length > 0)
    await deps.persist(finalists.map((candidate) => candidate.product));

  const measured = finalists.filter(
    (candidate) => candidate.product.measurement.dimensions !== null,
  ).length;
  return taskResult(
    task,
    finalists,
    failures,
    `Searched ${hits.length} ${task.category} listing(s) in the ${tierFor(task.maxPriceCents)} tier and kept ${finalists.length}, ${measured} of which have dimensions. Sizes are read from merchant pages and are estimates until confirmed.`,
  );
}

// The main agent plans several categories at once, so tasks run together, a few at a
// time: enough to keep the wait short without hammering the search provider.
export async function runSearches(
  tasks: SearchTask[],
  deps: PipelineDeps,
  options: Partial<PipelineOptions> = {},
  concurrency = 3,
): Promise<SearchTaskResult[]> {
  const results: SearchTaskResult[] = [];
  for (let start = 0; start < tasks.length; start += concurrency) {
    const batch = tasks.slice(start, start + concurrency);
    results.push(
      ...(await Promise.all(
        batch.map((task) => runSearch(task, deps, options)),
      )),
    );
  }
  return results;
}
