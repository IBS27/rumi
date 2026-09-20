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
import { factsFromJsonLd, factsFromShopify, nameFromTitle } from "./listing";
import { htmlToText, type PageContent } from "./page";
import { diversifyMerchants, rankCandidates } from "./rank";
import { mapShopifyProduct, productJsonUrl } from "./shopify";
import { tierFor } from "./retailers";
import {
  buildExaQuery,
  dedupeHits,
  dedupeProducts,
  diversifyHits,
  filterCandidates,
  merchantFor,
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
      title: live?.title || markup?.title || null,
      html: markup?.html ?? live?.html ?? null,
      // Rendered text may carry tags; block ends become line breaks so a packaging
      // note on one line cannot take a specification on the next down with it.
      text: [live ? htmlToText(live.text) : null, markup?.text]
        .filter(Boolean)
        .join("\n"),
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
  const jsonUrl = productJsonUrl(page.url);
  if (!jsonUrl) return { facts: {}, images: [], bodyText: "" };
  // A rendered or blocked page can lose Shopify's fingerprint. Probe the platform's
  // deterministic product endpoint for /products/ URLs; non-Shopify stores simply 404
  // or return a payload that mapShopifyProduct rejects.
  try {
    const payload = await deps.fetchJson(jsonUrl);
    const product = mapShopifyProduct(payload);
    return factsFromShopify(product, {
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

  const search = async (
    count: number,
    includeDomains: string[],
    label: string,
  ): Promise<ExaSearchHit[]> => {
    try {
      return await deps.search(query, count, includeDomains);
    } catch (error) {
      failures.push({
        stage: "search",
        detail: `${label} search failed: ${message(error)}.`,
      });
      return [];
    }
  };

  let hits = diversifyHits(
    dedupeHits(await search(settings.results, domains, "Retailer catalogue")),
  );
  let searchedOpenWeb = false;
  const merchantCount = () =>
    new Set(hits.map((hit) => merchantFor(hit.url))).size;
  if (
    hits.length < settings.minTierHits ||
    merchantCount() < Math.min(settings.target, 3)
  ) {
    searchedOpenWeb = true;
    failures.push({
      stage: "search",
      detail: `The retailer catalogue returned ${hits.length} result(s) across ${merchantCount()} merchant(s), so the open web was searched as well.`,
    });
    const open = await search(settings.results, [], "Open web");
    hits = diversifyHits(dedupeHits([...hits, ...open]));
  }
  if (hits.length === 0)
    return taskResult(
      task,
      [],
      [...failures, { stage: "search", detail: "No product pages matched." }],
      `No ${task.category} listings matched this search.`,
    );

  const candidates: ProductCandidate[] = [];
  const contexts = new Map<string, PageFacts>();
  let extractions = 0;
  const seenUrls = new Set<string>();

  const collect = async (batch: ExaSearchHit[]) => {
    const urls = batch
      .map((hit) => hit.url)
      .filter((url) => !seenUrls.has(url))
      .slice(0, settings.results);
    for (const url of urls) seenUrls.add(url);
    const pages = await gatherPages(urls, deps, failures);
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
      const pageText = [merchant.bodyText, page.text]
        .filter(Boolean)
        .join("\n");
      const images = [
        ...merchant.images,
        ...(jsonLd?.images ?? []).map((url) => ({ url, alt: null })),
        ...page.images,
      ];
      // The gallery is added last: merchant and structured images already lead it. The
      // page title is the last word on the name, after everything else was silent.
      const facts = pickFacts([
        ...layers,
        { images: images.map((image) => image.url) },
        { name: nameFromTitle(page.title) },
      ]);
      // Cheap stages only. A drawing is read later, and only if the ranking calls for it.
      const resolved = await resolveDimensions({
        category: task.category,
        structuredText: jsonLd?.dimensionText ?? null,
        pageText,
        images,
      });
      // Why a size could not be read is worth telling the caller even for a candidate
      // that never reaches the drawing stage.
      failures.push(...resolved.failures);
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
  };

  await collect(hits);
  let { kept, failures: filterFailures } = filterCandidates(
    dedupeProducts(candidates),
    task,
  );
  const keptMerchantCount = () =>
    new Set(kept.map((product) => product.merchant)).size;
  const measuredMerchantCount = () =>
    new Set(
      kept
        .filter((product) => product.measurement.dimensions !== null)
        .map((product) => product.merchant),
    ).size;
  // Retrieval can look diverse while every affordable, in-stock survivor comes from one
  // merchant, or while only one merchant publishes usable dimensions. Expand after the
  // real filters too, not only when the raw hit list is thin.
  if (
    (kept.length === 0 ||
      keptMerchantCount() < Math.min(settings.target, 3) ||
      measuredMerchantCount() < Math.min(settings.target, 3)) &&
    domains.length > 0 &&
    !searchedOpenWeb
  ) {
    failures.push({
      stage: "search",
      detail: `${kept.length} listing(s) across ${keptMerchantCount()} merchant(s) passed the catalogue filters, with usable dimensions from ${measuredMerchantCount()} merchant(s), so the open web was searched as well.`,
    });
    const open = await search(settings.results, [], "Open web");
    hits = diversifyHits(dedupeHits([...hits, ...open]));
    await collect(diversifyHits(dedupeHits(open)));
    ({ kept, failures: filterFailures } = filterCandidates(
      dedupeProducts(candidates),
      task,
    ));
  }
  failures.push(...filterFailures);

  const ranked = diversifyMerchants(
    rankCandidates(kept, task),
    settings.target,
  );

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

  const finalists = diversifyMerchants(
    rankCandidates(sized, task),
    settings.target,
  );
  if (deps.persist && finalists.length > 0)
    await deps.persist(finalists.map((candidate) => candidate.product));

  const seen = new Set<string>();
  const distinct = failures.filter((failure) => {
    const key = `${failure.stage}:${failure.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const measured = finalists.filter(
    (candidate) => candidate.product.measurement.dimensions !== null,
  ).length;
  return taskResult(
    task,
    finalists,
    distinct,
    `Searched ${hits.length} ${task.category} listing(s) across ${merchantCount()} merchant(s), through the ${tierFor(task.maxPriceCents)} tier, and kept ${finalists.length}; ${measured} have dimensions. Sizes are read from merchant pages and are estimates until confirmed.`,
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
