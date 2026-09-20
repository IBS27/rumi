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

// Search engines hand back the same listing under tracking and locale parameters, and
// category pages beside the products they list. Both cost a page read and a model call.
const TRACKING_PARAM =
  /^(utm_|ref$|ref_|lang$|locale$|cid$|gclid$|fbclid$|mc_|srsltid$|_pos$|_sid$|_ss$)/i;
const PRODUCT_PATH =
  /\/(products?|p|pdp|dp|item|items|prod)\/|\d{4,}|\.html?$/i;
const NUMERIC_CATEGORY_PATH = /^\/\d{2,}\/[^/]+\.html?\/?$/i;
const CATEGORY_SEGMENT =
  /^(collections?|categor(?:y|ies)|search|shop-all|in-stock.*|new-arrivals|browse|all-.+|c)$/i;

export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()])
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

export function looksLikeListing(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname + url.search;
    if (NUMERIC_CATEGORY_PATH.test(url.pathname)) return false;
    if (PRODUCT_PATH.test(path)) return true;
    return !url.pathname
      .split("/")
      .some((segment) => CATEGORY_SEGMENT.test(segment));
  } catch {
    return false;
  }
}

export function dedupeHits(hits: ExaSearchHit[]): ExaSearchHit[] {
  const seen = new Set<string>();
  const kept: ExaSearchHit[] = [];
  for (const hit of hits) {
    const canonical = canonicalUrl(hit.url);
    if (
      !canonical ||
      seen.has(canonical) ||
      !looksLikeListing(canonical) ||
      isUnsupportedMerchant(canonical)
    )
      continue;
    seen.add(canonical);
    kept.push({ ...hit, url: canonical });
  }
  return kept;
}

// Exa can index stale Amazon links and foreign storefronts whose prices are not USD.
// Do not return them under the catalog's USD contract.
// Large retailers also keep one host and put the country in the path, as in
// ikea.com/at/en/ or ikea.com/gb/en/. Only the US storefront is in USD.
const COUNTRY_PATH = /^\/([a-z]{2})(?:\/([a-z]{2}))?(?=\/|$)/i;
export function isUnsupportedMerchant(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    const topLevelDomain = hostname.split(".").at(-1) ?? "";
    if (hostname === "amazon.com" || hostname.endsWith(".amazon.com"))
      return true;
    if (topLevelDomain.length === 2 && topLevelDomain !== "us") return true;
    const match = COUNTRY_PATH.exec(url.pathname);
    // A leading two-letter pair like /at/en or /gb/en names a country and a
    // language. A single segment such as /en is a language only.
    return Boolean(match && match[2] && match[1].toLowerCase() !== "us");
  } catch {
    return true;
  }
}

// Search providers often return a full page from one heavily indexed retailer. Round
// robin by host before pages are fetched so those results cannot crowd every other shop
// (and every independent Shopify storefront) out of the extraction budget.
export function diversifyHits(hits: ExaSearchHit[]): ExaSearchHit[] {
  const queues = new Map<string, ExaSearchHit[]>();
  for (const hit of hits) {
    const merchant = merchantFor(hit.url);
    const queue = queues.get(merchant) ?? [];
    queue.push(hit);
    queues.set(merchant, queue);
  }
  const diversified: ExaSearchHit[] = [];
  let remaining = hits.length;
  while (remaining > 0) {
    for (const queue of queues.values()) {
      const hit = queue.shift();
      if (!hit) continue;
      diversified.push(hit);
      remaining--;
    }
  }
  return diversified;
}

// Retrieval reads better from a short noun phrase than from a sentence of constraints.
// Footprint and price are enforced in code, so only the price hint is worth a word.
export function buildExaQuery(task: SearchTask): string {
  const base = (task.query || task.category).trim();
  const lower = base.toLowerCase();
  // A modifier the query already says would only be repeated back at the index.
  const seen = new Set<string>();
  const modifiers = [...task.styleTerms, ...task.miscellaneous].filter((term) => {
    const normalized = term.toLowerCase();
    if (lower.includes(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  const parts = [...modifiers, base];
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

function normalizedText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

function includesTermPrefix(text: string, term: string): boolean {
  const normalized = normalizedText(term).trim();
  return new RegExp(`\\b${normalized}`).test(text);
}

// Hard constraints only. A product whose dimensions are still unknown survives here:
// it is resolved later, and ranked last if it stays unknown.
export function filterCandidates(
  products: ProductCandidate[],
  task: SearchTask,
): { kept: ProductCandidate[]; failures: SearchFailure[] } {
  const excluded = new Set(
    task.excludeTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
  );
  const failures: SearchFailure[] = [];
  const kept: ProductCandidate[] = [];
  const counts = {
    price: 0,
    availability: 0,
    size: 0,
    tags: 0,
  };
  for (const product of products) {
    if (product.availability === "unavailable") {
      counts.availability++;
      continue;
    }
    if (task.maxPriceCents > 0 && product.priceCents > task.maxPriceCents) {
      counts.price++;
      continue;
    }
    const searchable = normalizedText(
      `${product.name} ${product.tags.join(" ")} ${product.variantId}`,
    );
    if (
      [...excluded].some((tag) => includesTermPrefix(searchable, tag)) ||
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
