import {
  productSchema,
  type Category,
  type Measurement,
  type ProductCandidate,
} from "../contracts";
import { colorFromWords } from "./color";
import { merchantFor, productIdFor } from "./index";

// What a listing says about itself, whoever said it. Merchant data and model readings
// have the same shape so they can be layered in order of trust.
export interface ListingFacts {
  name: string | null;
  variant: string | null;
  priceCents: number | null;
  availability: "available" | "unavailable" | "unknown";
  colorText: string | null;
  colorHex: string | null;
  tags: string[];
  imageUrl: string | null;
  images: string[];
}

export const NO_FACTS: ListingFacts = {
  name: null,
  variant: null,
  priceCents: null,
  availability: "unknown",
  colorText: null,
  colorHex: null,
  tags: [],
  imageUrl: null,
  images: [],
};

// Neutral grey: a color we did not read, rather than a color we invented.
export const UNKNOWN_COLOR = "#9ca3af";

/** Earlier sources win. Merchant data is passed before anything a model produced. */
export function pickFacts(sources: Partial<ListingFacts>[]): ListingFacts {
  const facts: ListingFacts = { ...NO_FACTS, tags: [], images: [] };
  const tags: string[] = [];
  const images: string[] = [];
  let availabilitySet = false;
  for (const source of sources) {
    if (facts.name === null && source.name) facts.name = source.name;
    if (facts.variant === null && source.variant) facts.variant = source.variant;
    if (
      facts.priceCents === null &&
      typeof source.priceCents === "number" &&
      Number.isFinite(source.priceCents)
    )
      facts.priceCents = Math.round(source.priceCents);
    if (facts.colorText === null && source.colorText)
      facts.colorText = source.colorText;
    if (facts.colorHex === null && source.colorHex)
      facts.colorHex = source.colorHex;
    if (facts.imageUrl === null && source.imageUrl)
      facts.imageUrl = source.imageUrl;
    if (!availabilitySet && source.availability && source.availability !== "unknown") {
      facts.availability = source.availability;
      availabilitySet = true;
    }
    tags.push(...(source.tags ?? []));
    images.push(...(source.images ?? []));
  }
  facts.images = [...new Set(images)].slice(0, 8);
  if (facts.imageUrl === null) facts.imageUrl = facts.images[0] ?? null;
  facts.tags = [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ];
  return facts;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function resolveColor(facts: ListingFacts): string {
  if (facts.colorHex && HEX.test(facts.colorHex)) return facts.colorHex;
  for (const text of [facts.variant, facts.colorText, facts.name]) {
    const found = text ? colorFromWords(text) : null;
    if (found) return found.hex;
  }
  return UNKNOWN_COLOR;
}

export interface CandidateInput {
  sourceUrl: string;
  category: Category;
  facts: ListingFacts;
  measurement: Measurement;
}

export function buildCandidate({
  sourceUrl,
  category,
  facts,
  measurement,
}: CandidateInput): { product: ProductCandidate | null; issue: string | null } {
  if (!facts.name) return { product: null, issue: "The listing has no name." };
  if (facts.priceCents === null)
    return { product: null, issue: "The listing has no price." };
  const variant = facts.variant ?? "default";
  const parsed = productSchema.safeParse({
    id: productIdFor(sourceUrl, variant),
    variantId: variant,
    name: facts.name,
    category,
    merchant: merchantFor(sourceUrl),
    sourceUrl,
    imageUrl: facts.imageUrl,
    images: facts.images,
    priceCents: facts.priceCents,
    currency: "USD",
    measurement,
    color: resolveColor(facts),
    tags: facts.tags,
    availability: facts.availability,
    assetId: null,
    synthetic: false,
  });
  return parsed.success
    ? { product: parsed.data, issue: null }
    : {
        product: null,
        issue: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
}
