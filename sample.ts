import { writeFileSync } from "node:fs";
import { runSearch } from "./shared/search/pipeline";
import { fetchPage } from "./shared/search/page";
import { searchTaskSchema } from "./shared/contracts";

const list = await fetch("https://www.floydhome.com/products.json?limit=40", {
  headers: { "user-agent": "Mozilla/5.0" },
}).then((r) => r.json()) as { products: { handle: string; title: string; product_type: string }[] };
const picks = list.products.filter((p) => /table|block|shelf|storage|stand/i.test(`${p.title} ${p.product_type}`)).slice(0, 5);

const task = searchTaskSchema.parse({
  query: "bedside table",
  category: "storage",
  maxPriceCents: 60000,
  maxFootprint: { width: 0.6, depth: 0.5 },
  maxHeight: 0.8,
  styleTerms: ["minimalist", "oak"],
  palette: ["#1a1a1a", "#c19a6b"],
  excludeTags: [],
});

const result = await runSearch(task, {
  search: async () => picks.map((p) => ({ url: `https://www.floydhome.com/products/${p.handle}`, title: p.title })),
  fetchPage,
  fetchContents: async () => [],
  fetchJson: async (url: string) => {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    return await r.json();
  },
  extractListing: async () => { throw new Error("no model key configured yet"); },
  readDiagram: async (images) => ({ readings: [], imageUrl: images[0]?.url ?? null }),
}, { minTierHits: 1, results: 5 });

writeFileSync("sample-result.json", JSON.stringify(result, null, 2));
console.log("candidates:", result.candidates.length);
for (const c of result.candidates)
  console.log(` ${c.score.toFixed(2)} ${c.product.name} $${(c.product.priceCents/100).toFixed(2)} ${c.product.variantId} imgs=${c.product.images.length} dims=${c.product.measurement.evidence.kind}`);
console.log("failures:", result.failures.length);
