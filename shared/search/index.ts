import {
  searchTaskResultSchema,
  type ProductCandidate,
  type RankedCandidate,
  type SearchFailure,
  type SearchTask,
  type SearchTaskResult,
} from "../contracts";
import { formatMoney } from "../budget";
import { fitsTask } from "./rank";
import { domainsFor } from "./retailers";
import type { ImageRef } from "./images";

const EXA_API = "https://api.exa.ai";

export interface ExaSearchHit {
  url: string;
  title: string | null;
}

export interface ExaPageContent {
  url: string;
  title: string | null;
  text: string;
  html: string | null;
  images: ImageRef[];
}

interface ExaSearchResponse {
  results?: { url?: string; title?: string }[];
}

interface ExaContentResult {
  url?: string;
  title?: string;
  text?: string;
  image?: string;
  extras?: { imageLinks?: string[] };
}

interface ExaContentsResponse {
  results?: ExaContentResult[];
}

type FetchLike = typeof fetch;

async function exaPost<T>(
  apiKey: string,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await fetchImpl(`${EXA_API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Exa ${path} failed with status ${response.status}.`);
  return (await response.json()) as T;
}

export async function exaSearch(
  apiKey: string,
  query: string,
  numResults: number,
  includeDomains: string[] = [],
  fetchImpl: FetchLike = fetch,
): Promise<ExaSearchHit[]> {
  const data = await exaPost<ExaSearchResponse>(
    apiKey,
    "/search",
    {
      query,
      numResults,
      type: "auto",
      ...(includeDomains.length > 0 ? { includeDomains } : {}),
    },
    fetchImpl,
  );
  return (data.results ?? [])
    .filter((hit): hit is { url: string; title?: string } => !!hit.url)
    .map((hit) => ({ url: hit.url, title: hit.title ?? null }));
}

export async function exaContents(
  apiKey: string,
  urls: string[],
  maxCharacters = 24000,
  fetchImpl: FetchLike = fetch,
): Promise<ExaPageContent[]> {
  if (urls.length === 0) return [];
  const data = await exaPost<ExaContentsResponse>(
    apiKey,
    "/contents",
    {
      urls,
      text: { maxCharacters, includeHtmlTags: true },
      extras: { imageLinks: 10 },
    },
    fetchImpl,
  );
  return (data.results ?? [])
    .filter(
      (page): page is ExaContentResult & { url: string; text: string } =>
        !!page.url && !!page.text,
    )
    .map((page) => ({
      url: page.url,
      title: page.title ?? null,
      text: page.text,
      html: /<[a-z][\s\S]*>/i.test(page.text) ? page.text : null,
      images: [
        ...new Set([
          ...(page.image ? [page.image] : []),
          ...(page.extras?.imageLinks ?? []),
        ]),
      ].map((url) => ({ url, alt: null })),
    }));
}

// Retrieval reads better from a short noun phrase than from a sentence of constraints.
// Footprint and price are enforced in code, so only the price hint is worth a word.
export function buildExaQuery(task: SearchTask): string {
  const parts = [...task.styleTerms, task.query || task.category];
  if (task.maxPriceCents > 0)
    parts.push(`under ${formatMoney(task.maxPriceCents)}`);
  return parts.filter(Boolean).join(" ");
}

export function searchDomains(task: SearchTask): string[] {
  return domainsFor(task.maxPriceCents);
}

export function productIdFor(sourceUrl: string, variant: string): string {
  const input = `${sourceUrl}#${variant}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `web-${hash.toString(16).padStart(8, "0")}`;
}

export function merchantFor(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function dedupeProducts(
  products: ProductCandidate[],
): ProductCandidate[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = `${product.sourceUrl}#${product.variantId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Hard constraints only. A product whose dimensions are still unknown survives here:
// it is resolved later, and ranked last if it stays unknown.
export function filterCandidates(
  products: ProductCandidate[],
  task: SearchTask,
): { kept: ProductCandidate[]; failures: SearchFailure[] } {
  const excluded = new Set(task.excludeTags.map((tag) => tag.toLowerCase()));
  const failures: SearchFailure[] = [];
  const kept: ProductCandidate[] = [];
  const counts = { price: 0, availability: 0, size: 0, tags: 0 };
  for (const product of products) {
    if (product.availability === "unavailable") {
      counts.availability++;
      continue;
    }
    if (product.priceCents > task.maxPriceCents) {
      counts.price++;
      continue;
    }
    if (
      product.tags.some((tag) => excluded.has(tag.toLowerCase())) ||
      excluded.has(product.category)
    ) {
      counts.tags++;
      continue;
    }
    const dimensions = product.measurement.dimensions;
    if (dimensions && !fitsTask(dimensions, task)) {
      counts.size++;
      continue;
    }
    kept.push(product);
  }
  if (counts.availability)
    failures.push({
      stage: "filter",
      detail: `Dropped ${counts.availability} unavailable product(s).`,
    });
  if (counts.price)
    failures.push({
      stage: "filter",
      detail: `Dropped ${counts.price} product(s) over the ${formatMoney(task.maxPriceCents)} price ceiling.`,
    });
  if (counts.tags)
    failures.push({
      stage: "filter",
      detail: `Dropped ${counts.tags} product(s) matching excluded tags.`,
    });
  if (counts.size)
    failures.push({
      stage: "filter",
      detail: `Dropped ${counts.size} product(s) larger than the space allowed.`,
    });
  return { kept, failures };
}

export interface ResolveToFitInput {
  candidates: ProductCandidate[];
  task: SearchTask;
  /** How many candidates with usable dimensions the caller wants. */
  target: number;
  /** Ceiling on expensive resolutions, whatever the outcome. */
  maxResolutions: number;
  resolve: (
    product: ProductCandidate,
  ) => Promise<{ product: ProductCandidate; failures: SearchFailure[] }>;
}

// Filtering to three candidates and then finding that none of them publish dimensions
// leaves the room with a hole. So walk the ranked list, paying for dimensions only
// until enough candidates fit.
export async function resolveToFit({
  candidates,
  task,
  target,
  maxResolutions,
  resolve,
}: ResolveToFitInput): Promise<{
  kept: ProductCandidate[];
  failures: SearchFailure[];
}> {
  const failures: SearchFailure[] = [];
  const fitting: ProductCandidate[] = [];
  const unknown: ProductCandidate[] = [];
  let resolutions = 0;
  for (const candidate of candidates) {
    if (fitting.length >= target) break;
    let product = candidate;
    if (!product.measurement.dimensions) {
      if (resolutions >= maxResolutions) {
        unknown.push(product);
        continue;
      }
      resolutions++;
      const resolved = await resolve(product);
      product = resolved.product;
      failures.push(...resolved.failures);
    }
    const dimensions = product.measurement.dimensions;
    if (!dimensions) {
      unknown.push(product);
      continue;
    }
    if (!fitsTask(dimensions, task)) {
      failures.push({
        stage: "filter",
        detail: `${product.name} is larger than the space allowed.`,
      });
      continue;
    }
    fitting.push(product);
  }
  const shortfall = Math.max(0, target - fitting.length);
  return { kept: [...fitting, ...unknown.slice(0, shortfall)], failures };
}

export function taskResult(
  task: SearchTask,
  candidates: RankedCandidate[],
  failures: SearchFailure[],
  explanation: string,
): SearchTaskResult {
  return searchTaskResultSchema.parse({
    category: task.category,
    query: task.query,
    candidates,
    explanation,
    failures,
  });
}
