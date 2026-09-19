import type { ListingFacts } from "./candidate";
import { UNKNOWN_COLOR } from "./candidate";
import { colorFromWords, paletteScore } from "./color";
import type { ImageRef } from "./images";
import type { JsonLdProduct } from "./jsonld";
import type { ShopifyProduct, ShopifyVariant } from "./shopify";

// Turning merchant data into the shape the candidate builder layers. Merchant numbers
// are preferred over anything a model reads off a page, so these run first.

export function factsFromJsonLd(
  product: JsonLdProduct | null,
): Partial<ListingFacts> {
  if (!product) return {};
  return {
    name: product.name,
    variant: product.sku,
    priceCents: product.priceCents,
    availability: product.availability,
    colorText: product.color,
    imageUrl: product.images[0] ?? null,
    images: product.images,
  };
}

export interface VariantChoice {
  maxPriceCents: number;
  palette: string[];
}

// Within budget and in stock first; among those, the finish closest to the palette.
export function chooseVariant(
  product: ShopifyProduct,
  { maxPriceCents, palette }: VariantChoice,
): ShopifyVariant | null {
  if (product.variants.length === 0) return null;
  const affordable = product.variants.filter(
    (variant) => variant.available && variant.priceCents <= maxPriceCents,
  );
  const available = product.variants.filter((variant) => variant.available);
  const pool =
    affordable.length > 0
      ? affordable
      : available.length > 0
        ? available
        : product.variants;
  return [...pool].sort((a, b) => {
    const score = (variant: ShopifyVariant) =>
      paletteScore(colorFromWords(variant.title)?.hex ?? UNKNOWN_COLOR, palette);
    const difference = score(b) - score(a);
    return difference !== 0 ? difference : a.priceCents - b.priceCents;
  })[0];
}

export interface ShopifyFacts {
  facts: Partial<ListingFacts>;
  images: ImageRef[];
  bodyText: string;
}

export function factsFromShopify(
  product: ShopifyProduct | null,
  choice: VariantChoice,
): ShopifyFacts {
  if (!product) return { facts: {}, images: [], bodyText: "" };
  const variant = chooseVariant(product, choice);
  return {
    facts: {
      name: product.title,
      variant: variant?.title ?? null,
      priceCents: variant?.priceCents ?? null,
      availability: variant
        ? variant.available
          ? "available"
          : "unavailable"
        : "unknown",
      colorText: variant?.title ?? null,
      tags: [...product.tags, product.productType ?? ""].filter(Boolean),
      imageUrl: product.images[0]?.url ?? null,
      images: product.images.map((image) => image.url),
    },
    images: product.images,
    bodyText: product.bodyText,
  };
}
