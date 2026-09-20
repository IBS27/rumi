import { describe, expect, it } from "bun:test";
import { productSchema, searchTaskSchema } from "../shared/contracts";
import { edgeCaseProducts, sampleProducts } from "../shared/fixtures";
import {
  buildExaQuery,
  dedupeProducts,
  exaContents,
  exaSearch,
  filterCandidates,
  merchantFor,
  productIdFor,
} from "../shared/search";

const task = searchTaskSchema.parse({
  query: "wool rug",
  category: "rug",
  maxPriceCents: 15000,
  maxFootprint: { width: 2, depth: 2.5 },
  styleTerms: ["minimalist", "warm"],
  excludeTags: [],
});

describe("search subagent pipeline", () => {
  it("rejects invalid task constraints", () => {
    expect(
      searchTaskSchema.safeParse({ ...task, maxPriceCents: -1 }).success,
    ).toBe(false);
    expect(
      searchTaskSchema.safeParse({
        ...task,
        maxFootprint: { width: 0, depth: 1 },
      }).success,
    ).toBe(false);
  });
  it("builds a query carrying style, footprint, and price ceilings", () => {
    const query = buildExaQuery(task);
    expect(query).toContain("wool rug");
    expect(query).toContain("minimalist");
    expect(query).toContain("2m wide and 2.5m deep");
    expect(query).toContain("$150");
  });
  it("derives stable product ids and clean merchant names", () => {
    const url = "https://www.ikea.com/us/en/p/friheten-123";
    expect(productIdFor(url, "sleeper-gray")).toBe(
      productIdFor(url, "sleeper-gray"),
    );
    expect(productIdFor(url, "sleeper-gray")).not.toBe(
      productIdFor(url, "sleeper-beige"),
    );
    expect(merchantFor(url)).toBe("ikea.com");
  });
  it("dedupes repeated variants", () => {
    const duplicate = productSchema.parse({
      ...sampleProducts[0],
      id: "different-id",
    });
    expect(dedupeProducts([sampleProducts[0], duplicate])).toHaveLength(1);
  });
  it("drops unavailable and over-budget candidates with reasons", () => {
    const { kept, failures } = filterCandidates(
      [
        sampleProducts[0],
        edgeCaseProducts.unavailable,
        edgeCaseProducts.overBudget,
      ],
      task,
    );
    expect(kept.map((product) => product.id)).toEqual(["arc-lamp"]);
    expect(failures.map((failure) => failure.detail).join(" ")).toContain(
      "over the $150 price ceiling",
    );
    expect(failures.map((failure) => failure.detail).join(" ")).toContain(
      "unavailable",
    );
  });
  it("enforces the footprint ceiling but allows rotated fits and unknown dimensions", () => {
    const rotated = productSchema.parse({
      ...sampleProducts[1],
      id: "rotated",
      sourceUrl: "https://example.com/products/rotated",
      variantId: "rotated-variant",
      measurement: {
        dimensions: { width: 1.2, height: 0.1, depth: 0.6 },
        source: "confirmed",
      },
    });
    const tight = searchTaskSchema.parse({
      ...task,
      maxFootprint: { width: 0.8, depth: 1.5 },
    });
    const { kept } = filterCandidates(
      [rotated, edgeCaseProducts.oversized, edgeCaseProducts.unknownDimensions],
      tight,
    );
    expect(kept.map((product) => product.id).sort()).toEqual([
      "rotated",
      "unknown",
    ]);
  });
  it("drops candidates matching excluded tags", () => {
    const { kept } = filterCandidates(
      [sampleProducts[3]],
      searchTaskSchema.parse({ ...task, excludeTags: ["art"] }),
    );
    expect(kept).toHaveLength(0);
  });
  it("maps Exa responses and filters empty pages", async () => {
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/search"))
        return Response.json({
          results: [{ url: "https://a.com/p1", title: "P1" }, { title: "no url" }],
        });
      if (String(url).endsWith("/contents"))
        return Response.json({
          results: [
            { url: body.urls[0], title: "P1", text: "page text" },
            { url: "https://a.com/p2" },
          ],
        });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const hits = await exaSearch("key", "rug", 3, fakeFetch);
    expect(hits).toEqual([{ url: "https://a.com/p1", title: "P1" }]);
    const pages = await exaContents("key", ["https://a.com/p1"], 100, fakeFetch);
    expect(pages).toEqual([
      { url: "https://a.com/p1", title: "P1", text: "page text" },
    ]);
  });
  it("throws on failed Exa responses", async () => {
    const failingFetch = (async () =>
      new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(exaSearch("key", "rug", 3, failingFetch)).rejects.toThrow(
      "403",
    );
  });
});
