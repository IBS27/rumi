import type {
  Dimensions,
  ProductCandidate,
  RankedCandidate,
  ScoreBreakdown,
  SearchTask,
} from "../contracts";
import { paletteScore } from "./color";

const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  fit: 0.3,
  style: 0.25,
  color: 0.2,
  price: 0.15,
  completeness: 0.1,
};

const clamp = (value: number) => Math.min(1, Math.max(0, value));

// Best orientation: a piece may be rotated a quarter turn to fit an opening.
export function footprintArea(dimensions: Dimensions): number {
  return dimensions.width * dimensions.depth;
}

export function fitsTask(dimensions: Dimensions, task: SearchTask): boolean {
  if (task.maxHeight !== null && dimensions.height > task.maxHeight)
    return false;
  if (!task.maxFootprint) return true;
  const { width, depth } = task.maxFootprint;
  return (
    (dimensions.width <= width && dimensions.depth <= depth) ||
    (dimensions.width <= depth && dimensions.depth <= width)
  );
}

// A piece that leaves most of the opening empty looks wrong, so filling the allowed
// footprint scores higher than merely fitting inside it.
function fitScore(product: ProductCandidate, task: SearchTask): number {
  const dimensions = product.measurement.dimensions;
  if (!dimensions) return 0;
  if (!task.maxFootprint) return 0.6;
  if (!fitsTask(dimensions, task)) return 0;
  const ratio =
    footprintArea(dimensions) /
    (task.maxFootprint.width * task.maxFootprint.depth);
  return clamp(ratio <= 0.25 ? ratio * 2 : 0.5 + (ratio - 0.25) / 1.5);
}

function styleScore(product: ProductCandidate, task: SearchTask): number {
  if (task.styleTerms.length === 0) return 0.5;
  const haystack =
    `${product.name} ${product.tags.join(" ")} ${product.variantId}`.toLowerCase();
  const hits = task.styleTerms.filter((term) =>
    haystack.includes(term.toLowerCase()),
  ).length;
  return clamp(hits / task.styleTerms.length);
}

// Rewards sensible use of the ceiling. Far below it usually means an accessory or a
// part, not a bargain.
function priceScore(product: ProductCandidate, task: SearchTask): number {
  if (task.maxPriceCents <= 0) return 0.5;
  const ratio = product.priceCents / task.maxPriceCents;
  if (ratio <= 0.2) return clamp(ratio * 2.5);
  if (ratio <= 0.6) return clamp(0.5 + ((ratio - 0.2) / 0.4) * 0.5);
  return clamp(1 - ((ratio - 0.6) / 0.4) * 0.4);
}

function completenessScore(product: ProductCandidate): number {
  const evidence = product.measurement.evidence.kind;
  const byEvidence =
    evidence === "structured" || evidence === "spec-text"
      ? 0.5
      : evidence === "mixed"
        ? 0.4
        : evidence === "image"
          ? 0.3
          : 0;
  const byAvailability =
    product.availability === "available"
      ? 0.3
      : product.availability === "unknown"
        ? 0.1
        : 0;
  return clamp(byEvidence + byAvailability + (product.imageUrl ? 0.2 : 0));
}

export function scoreCandidate(
  product: ProductCandidate,
  task: SearchTask,
): RankedCandidate {
  const breakdown: ScoreBreakdown = {
    fit: fitScore(product, task),
    style: styleScore(product, task),
    color: paletteScore(product.color, task.palette),
    price: priceScore(product, task),
    completeness: completenessScore(product),
  };
  const score = (Object.keys(WEIGHTS) as (keyof ScoreBreakdown)[]).reduce(
    (total, key) => total + breakdown[key] * WEIGHTS[key],
    0,
  );
  return { product, score: clamp(Math.round(score * 1000) / 1000), breakdown };
}

// --- Dedupe ----------------------------------------------------------------

const NOISE = new Set([
  "the",
  "a",
  "with",
  "and",
  "for",
  "in",
  "inch",
  "new",
]);

function titleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !NOISE.has(word))
    .sort()
    .join(" ");
}

function completeness(product: ProductCandidate): number {
  return completenessScore(product);
}

// The same product listed by several merchants must not fill the whole result.
export function dedupeListings(
  products: ProductCandidate[],
  priceTolerance = 0.1,
): ProductCandidate[] {
  const kept: ProductCandidate[] = [];
  for (const product of products) {
    const key = titleKey(product.name);
    const index = kept.findIndex((existing) => {
      if (titleKey(existing.name) !== key) return false;
      const spread =
        Math.abs(existing.priceCents - product.priceCents) /
        Math.max(existing.priceCents, product.priceCents, 1);
      return spread <= priceTolerance;
    });
    if (index === -1) {
      kept.push(product);
      continue;
    }
    const existing = kept[index];
    const better =
      completeness(product) > completeness(existing) ||
      (completeness(product) === completeness(existing) &&
        product.priceCents < existing.priceCents);
    if (better) kept[index] = product;
  }
  return kept;
}

export function rankCandidates(
  products: ProductCandidate[],
  task: SearchTask,
): RankedCandidate[] {
  return dedupeListings(products)
    .map((product) => scoreCandidate(product, task))
    .sort((a, b) => {
      const known = (candidate: RankedCandidate) =>
        candidate.product.measurement.dimensions ? 1 : 0;
      if (known(a) !== known(b)) return known(b) - known(a);
      return b.score - a.score;
    });
}
