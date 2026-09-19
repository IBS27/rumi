// schema.org Product data, when a retailer publishes it, is the cheapest and most
// reliable source on the page: no model call, no guessing.

export interface JsonLdProduct {
  name: string | null;
  priceCents: number | null;
  currency: string | null;
  availability: "available" | "unavailable" | "unknown";
  images: string[];
  sku: string | null;
  color: string | null;
  // Rebuilt as labelled text so the dimension parser owns units and plausibility.
  dimensionText: string | null;
}

const UNIT_CODES: Record<string, string> = {
  INH: "in",
  FOT: "ft",
  CMT: "cm",
  MMT: "mm",
  MTR: "m",
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(node: Json): string[] {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw))
    return raw.filter((t): t is string => typeof t === "string");
  return [];
}

function* walk(node: unknown): Generator<Json> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
    return;
  }
  if (!isObject(node)) return;
  yield node;
  if ("@graph" in node) yield* walk(node["@graph"]);
}

function blocks(html: string): Json[] {
  const found: Json[] = [];
  const pattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      for (const node of walk(parsed)) found.push(node);
    } catch {
      continue; // A broken block is ignored, never guessed at.
    }
  }
  return found;
}

function toCents(value: unknown): number | null {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[^0-9.]/g, ""))
        : NaN;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function readOffer(node: Json): {
  priceCents: number | null;
  currency: string | null;
  availability: JsonLdProduct["availability"];
} {
  const raw = node.offers;
  const offer = Array.isArray(raw) ? raw.find(isObject) : raw;
  if (!isObject(offer))
    return { priceCents: null, currency: null, availability: "unknown" };
  const priceCents = toCents(offer.price ?? offer.lowPrice);
  const state = String(offer.availability ?? "").toLowerCase();
  const availability = state.includes("instock")
    ? "available"
    : state.includes("outofstock") ||
        state.includes("soldout") ||
        state.includes("discontinued")
      ? "unavailable"
      : "unknown";
  return {
    priceCents,
    currency:
      typeof offer.priceCurrency === "string" ? offer.priceCurrency : null,
    availability,
  };
}

function quantity(node: unknown): string | null {
  if (typeof node === "number") return String(node);
  if (typeof node === "string") return node;
  if (!isObject(node)) return null;
  const value = node.value ?? node.minValue;
  if (value === undefined) return null;
  const unit =
    typeof node.unitCode === "string"
      ? (UNIT_CODES[node.unitCode] ?? node.unitCode)
      : typeof node.unitText === "string"
        ? node.unitText
        : "";
  return `${String(value)} ${unit}`.trim();
}

function readDimensions(node: Json): string | null {
  const lines: string[] = [];
  for (const axis of ["width", "depth", "height"] as const) {
    const printed = quantity(node[axis]);
    if (printed) lines.push(`${axis}: ${printed}`);
  }
  const extra = node.additionalProperty;
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      if (!isObject(entry)) continue;
      const name = String(entry.name ?? "").toLowerCase();
      if (!["width", "depth", "height"].includes(name)) continue;
      if (lines.some((line) => line.startsWith(name))) continue;
      const printed = quantity(entry);
      if (printed) lines.push(`${name}: ${printed}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function readImages(node: Json): string[] {
  const raw = node.image;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((item) =>
      typeof item === "string"
        ? item
        : isObject(item) && typeof item.url === "string"
          ? item.url
          : null,
    )
    .filter((url): url is string => url !== null);
}

export function parseProductJsonLd(html: string): JsonLdProduct | null {
  const product = blocks(html).find((node) => typeOf(node).includes("Product"));
  if (!product) return null;
  const offer = readOffer(product);
  return {
    name: typeof product.name === "string" ? product.name : null,
    priceCents: offer.priceCents,
    currency: offer.currency,
    availability: offer.availability,
    images: readImages(product),
    sku: typeof product.sku === "string" ? product.sku : null,
    color: typeof product.color === "string" ? product.color : null,
    dimensionText: readDimensions(product),
  };
}
