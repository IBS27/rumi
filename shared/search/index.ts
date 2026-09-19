import {
  searchTaskResultSchema,
  type ProductCandidate,
  type SearchFailure,
  type SearchTask,
  type SearchTaskResult,
} from "../contracts";
import { formatMoney } from "../budget";

const EXA_API = "https://api.exa.ai";

export interface ExaSearchHit {
  url: string;
  title: string | null;
}

export interface ExaPageContent {
  url: string;
  title: string | null;
  text: string;
}

interface ExaSearchResponse {
  results?: { url?: string; title?: string }[];
}

interface ExaContentsResponse {
  results?: { url?: string; title?: string; text?: string }[];
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
  fetchImpl: FetchLike = fetch,
): Promise<ExaSearchHit[]> {
  const data = await exaPost<ExaSearchResponse>(
    apiKey,
    "/search",
    { query, numResults, type: "auto" },
    fetchImpl,
  );
  return (data.results ?? [])
    .filter((hit): hit is { url: string; title?: string } => !!hit.url)
    .map((hit) => ({ url: hit.url, title: hit.title ?? null }));
}

export async function exaContents(
  apiKey: string,
  urls: string[],
  maxCharacters = 8000,
  fetchImpl: FetchLike = fetch,
): Promise<ExaPageContent[]> {
  if (urls.length === 0) return [];
  const data = await exaPost<ExaContentsResponse>(
    apiKey,
    "/contents",
    { urls, text: { maxCharacters } },
    fetchImpl,
  );
  return (data.results ?? [])
    .filter(
      (page): page is { url: string; title?: string; text: string } =>
        !!page.url && !!page.text,
    )
    .map((page) => ({
      url: page.url,
      title: page.title ?? null,
      text: page.text,
    }));
}

export function buildExaQuery(task: SearchTask): string {
  const parts = [task.query, task.category, ...task.styleTerms];
  if (task.maxFootprint)
    parts.push(
      `up to ${task.maxFootprint.width}m wide and ${task.maxFootprint.depth}m deep`,
    );
  if (task.maxPriceCents > 0)
    parts.push(`under ${formatMoney(task.maxPriceCents)}`);
  return parts.filter(Boolean).join(" ");
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

function fitsFootprint(
  product: ProductCandidate,
  footprint: { width: number; depth: number },
): boolean {
  const dims = product.measurement.dimensions;
  if (!dims) return true;
  return (
    (dims.width <= footprint.width && dims.depth <= footprint.depth) ||
    (dims.width <= footprint.depth && dims.depth <= footprint.width)
  );
}

export function filterCandidates(
  products: ProductCandidate[],
  task: SearchTask,
): { kept: ProductCandidate[]; failures: SearchFailure[] } {
  const excluded = new Set(task.excludeTags.map((tag) => tag.toLowerCase()));
  const failures: SearchFailure[] = [];
  const kept: ProductCandidate[] = [];
  const counts = { price: 0, availability: 0, footprint: 0, tags: 0 };
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
    if (task.maxFootprint && !fitsFootprint(product, task.maxFootprint)) {
      counts.footprint++;
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
  if (counts.footprint)
    failures.push({
      stage: "filter",
      detail: `Dropped ${counts.footprint} product(s) larger than ${task.maxFootprint?.width}m x ${task.maxFootprint?.depth}m.`,
    });
  return { kept, failures };
}

export function taskResult(input: SearchTaskResult): SearchTaskResult {
  return searchTaskResultSchema.parse(input);
}
