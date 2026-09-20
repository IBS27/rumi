import type { ProductCandidate } from "../contracts";

/** Catalog requirements shared by placement controls and their click handler. */
export function productPlacementIssue(
  product: ProductCandidate,
): string | null {
  if (product.availability !== "available")
    return "This product is not currently available. Ask Rumi to find an alternative.";
  if (!product.measurement.dimensions)
    return "Dimensions are unknown. Ask Rumi to find a product with known dimensions before placing it.";
  return null;
}
