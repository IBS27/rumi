import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ProductCandidate } from "../contracts";

export function digest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

/** Stable across extraction order, locale tracking and display-name changes. */
export function catalogKey(sourceUrl: string, variant: string): string {
  const url = new URL(sourceUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|ref$|gclid$|fbclid$|srsltid$)/i.test(key))
      url.searchParams.delete(key);
  url.searchParams.sort();
  return JSON.stringify([url.toString(), variant]);
}

export function assetKey(product: ProductCandidate): string {
  return `${product.id}-${digest(JSON.stringify([product.measurement.dimensions ? [product.measurement.dimensions.width, product.measurement.dimensions.height, product.measurement.dimensions.depth] : null, product.images, 1])).slice(0, 24)}-asset`;
}
