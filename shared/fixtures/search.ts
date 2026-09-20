import {
  searchRequestSchema,
  searchResultSchema,
  type SearchRequest,
  type SearchResult,
} from "../contracts";
import { sampleProducts } from "./index";
import { selectionTotal } from "../budget";

// Replace this adapter with a Convex action. Both sides keep these contracts.
export function fixtureSearch(input: SearchRequest): SearchResult {
  const { room, brief, query } = searchRequestSchema.parse(input);
  const remaining =
    brief.budgetCents > 0
      ? brief.budgetCents - selectionTotal(room, sampleProducts)
      : Number.POSITIVE_INFINITY;
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2);
  const score = (text: string) =>
    words.filter((word) => text.includes(word)).length;
  const products = sampleProducts
    .filter(
      (product) =>
        product.priceCents <= remaining && product.availability === "available",
    )
    .sort(
      (a, b) =>
        score(`${b.name} ${b.tags.join(" ")}`.toLowerCase()) -
        score(`${a.name} ${a.tags.join(" ")}`.toLowerCase()),
    );
  return searchResultSchema.parse({
    products,
    explanation:
      "I ranked the sample catalog against your request and remaining budget. Choose an item to preview it in your room. This is a fixture response, not a live AI search.",
  });
}
