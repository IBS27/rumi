import { describe, expect, it } from "bun:test";
import {
  buildExaQuery,
  dedupeProducts,
  exaContents,
  exaSearch,
  filterCandidates,
  merchantFor,
  productIdFor,
  resolveToFit,
  searchDomains,
  taskResult,
} from "../shared/search";
import { rankCandidates } from "../shared/search/rank";
import { makeProduct, makeTask } from "./helpers";

const unknownDimensions = {
  dimensions: null,
  source: "unknown",
  evidence: { kind: "none", detail: null },
} as const;

function fakeFetch(
  handler: (url: string, body: unknown) => { ok?: boolean; json: unknown },
) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const response = handler(url, body);
    return {
      ok: response.ok ?? true,
      status: response.ok === false ? 500 : 200,
      json: async () => response.json,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("query building", () => {
  it("carries style terms and the price ceiling", () => {
    const query = buildExaQuery(
      makeTask({ query: "oak wardrobe", maxPriceCents: 40000 }),
    );
    expect(query).toContain("oak wardrobe");
    expect(query).toContain("minimalist");
    expect(query).toContain("$400");
  });

  it("does not repeat a style word the query already says", () => {
    expect(
      buildExaQuery(
        makeTask({ query: "oak wardrobe", styleTerms: ["oak", "minimalist"] }),
      ),
    ).toBe("minimalist oak wardrobe under $400");
  });

  it("falls back to the category when there is no query", () => {
    expect(buildExaQuery(makeTask({ query: "" }))).toContain("storage");
  });

  it("chooses retailer domains from the price ceiling", () => {
    expect(searchDomains(makeTask({ maxPriceCents: 5000 }))).toContain(
      "ikea.com",
    );
    expect(searchDomains(makeTask({ maxPriceCents: 200000 }))).toContain(
      "dwr.com",
    );
  });
});

describe("the Exa client", () => {
  it("restricts a search to the tier's domains", async () => {
    const fetcher = fakeFetch(() => ({
      json: { results: [{ url: "https://ikea.com/p/1", title: "Cabinet" }] },
    }));
    const hits = await exaSearch(
      "key",
      "oak cabinet",
      8,
      ["ikea.com"],
      fetcher.impl,
    );
    expect(hits).toEqual([{ url: "https://ikea.com/p/1", title: "Cabinet" }]);
    expect(
      (fetcher.calls[0].body as { includeDomains: string[] }).includeDomains,
    ).toEqual(["ikea.com"]);
  });

  it("omits the domain restriction when falling back to the open web", async () => {
    const fetcher = fakeFetch(() => ({ json: { results: [] } }));
    await exaSearch("key", "oak cabinet", 8, [], fetcher.impl);
    expect(fetcher.calls[0].body).not.toHaveProperty("includeDomains");
  });

  it("maps page contents and keeps image links", async () => {
    const fetcher = fakeFetch(() => ({
      json: {
        results: [
          {
            url: "https://shop.test/p/1",
            title: "Cabinet",
            text: "Width: 110 cm",
            image: "https://shop.test/hero.jpg",
            extras: { imageLinks: ["https://shop.test/dimensions.jpg"] },
          },
          { url: "https://shop.test/p/2" },
        ],
      },
    }));
    const pages = await exaContents(
      "key",
      ["https://shop.test/p/1", "https://shop.test/p/2"],
      24000,
      fetcher.impl,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].images).toEqual([
      { url: "https://shop.test/hero.jpg", alt: null },
      { url: "https://shop.test/dimensions.jpg", alt: null },
    ]);
  });

  it("raises a clear error when Exa fails", async () => {
    const fetcher = fakeFetch(() => ({ ok: false, json: {} }));
    expect(exaSearch("key", "oak", 8, [], fetcher.impl)).rejects.toThrow(
      "status 500",
    );
  });
});

describe("identity helpers", () => {
  it("derives stable ids and clean merchant names", () => {
    const id = productIdFor("https://shop.test/p/1", "oak");
    expect(id).toBe(productIdFor("https://shop.test/p/1", "oak"));
    expect(id).not.toBe(productIdFor("https://shop.test/p/1", "walnut"));
    expect(merchantFor("https://www.shop.test/p/1")).toBe("shop.test");
    expect(merchantFor("not a url")).toBe("unknown");
  });

  it("drops a repeated variant of the same listing", () => {
    const product = makeProduct();
    expect(dedupeProducts([product, { ...product, id: "other" }])).toHaveLength(
      1,
    );
  });
});

describe("hard filters", () => {
  const task = makeTask({ maxPriceCents: 30000, excludeTags: ["baroque"] });

  it("drops unavailable, over-budget, excluded and oversized products", () => {
    const { kept, failures } = filterCandidates(
      [
        makeProduct({ id: "ok" }),
        makeProduct({ id: "gone", availability: "unavailable" }),
        makeProduct({ id: "pricey", priceCents: 90000 }),
        makeProduct({ id: "ornate", tags: ["baroque"] }),
        makeProduct({
          id: "huge",
          measurement: {
            dimensions: { width: 3, height: 0.7, depth: 0.6 },
            source: "estimated",
            evidence: { kind: "spec-text", detail: "spec" },
          },
        }),
      ],
      task,
    );
    expect(kept.map((product) => product.id)).toEqual(["ok"]);
    expect(failures).toHaveLength(4);
  });

  it("keeps a product whose dimensions are not known yet", () => {
    const { kept } = filterCandidates(
      [makeProduct({ id: "unsized", measurement: unknownDimensions })],
      task,
    );
    expect(kept.map((product) => product.id)).toEqual(["unsized"]);
  });

  it("drops a product taller than the space allows", () => {
    const { kept } = filterCandidates(
      [
        makeProduct({
          measurement: {
            dimensions: { width: 1, height: 2.4, depth: 0.4 },
            source: "estimated",
            evidence: { kind: "spec-text", detail: "spec" },
          },
        }),
      ],
      makeTask({ maxHeight: 2 }),
    );
    expect(kept).toHaveLength(0);
  });
});

describe("resolving dimensions until enough candidates fit", () => {
  const sized = (width: number) => ({
    dimensions: { width, height: 0.7, depth: 0.4 },
    source: "estimated" as const,
    evidence: { kind: "image" as const, detail: "diagram" },
  });

  it("stops paying once the target is met", async () => {
    let resolved = 0;
    const result = await resolveToFit({
      candidates: [
        makeProduct({ id: "a" }),
        makeProduct({ id: "b", measurement: unknownDimensions }),
        makeProduct({ id: "c", measurement: unknownDimensions }),
      ],
      task: makeTask(),
      target: 2,
      maxResolutions: 3,
      resolve: async (product) => {
        resolved += 1;
        return {
          product: { ...product, measurement: sized(1) },
          failures: [],
        };
      },
    });
    expect(result.kept.map((product) => product.id)).toEqual(["a", "b"]);
    expect(resolved).toBe(1);
  });

  it("drops a resolved product that turns out not to fit", async () => {
    const result = await resolveToFit({
      candidates: [makeProduct({ id: "big", measurement: unknownDimensions })],
      task: makeTask(),
      target: 1,
      maxResolutions: 2,
      resolve: async (product) => ({
        product: { ...product, measurement: sized(2.5) },
        failures: [],
      }),
    });
    expect(result.kept).toHaveLength(0);
    expect(result.failures[0].detail).toContain("larger than the space");
  });

  it("returns unresolved candidates rather than nothing", async () => {
    const result = await resolveToFit({
      candidates: [
        makeProduct({ id: "a", measurement: unknownDimensions }),
        makeProduct({ id: "b", measurement: unknownDimensions }),
      ],
      task: makeTask(),
      target: 2,
      maxResolutions: 1,
      resolve: async (product) => ({ product, failures: [] }),
    });
    expect(result.kept.map((product) => product.id)).toEqual(["a", "b"]);
  });

  it("respects the resolution budget", async () => {
    let resolved = 0;
    await resolveToFit({
      candidates: Array.from({ length: 6 }, (_, index) =>
        makeProduct({
          id: `p${index}`,
          measurement: unknownDimensions,
          sourceUrl: `https://example.com/p/${index}`,
        }),
      ),
      task: makeTask(),
      target: 5,
      maxResolutions: 2,
      resolve: async (product) => {
        resolved += 1;
        return { product, failures: [] };
      },
    });
    expect(resolved).toBe(2);
  });
});

describe("the task result", () => {
  it("validates against the contract", () => {
    const task = makeTask();
    const result = taskResult(
      task,
      rankCandidates([makeProduct()], task),
      [{ stage: "filter", detail: "Dropped 1 product." }],
      "Searched the mid tier.",
    );
    expect(result.category).toBe("storage");
    expect(result.candidates[0].breakdown.fit).toBeGreaterThan(0);
  });
});
