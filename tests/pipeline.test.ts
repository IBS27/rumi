import { describe, expect, it } from "bun:test";
import {
  runSearch,
  runSearches,
  type PipelineDeps,
} from "../shared/search/pipeline";
import type { PageContent } from "../shared/search/page";
import type { AxisReading } from "../shared/search/dimensions";
import { makeTask } from "./helpers";

const specPage = (url: string, extra = ""): PageContent => ({
  url,
  title: "Low oak cabinet",
  html: `<html><body><h1>Low oak cabinet</h1>${extra}</body></html>`,
  text: 'Low oak cabinet. Minimalist natural oak. Product Dimensions: 43"W x 14"D x 28"H. $249.00',
  images: [{ url: `${url}/hero.jpg`, alt: "cabinet" }],
});

const jsonLdPage = (url: string): PageContent => {
  const jsonLd = {
    "@type": "Product",
    name: "Oak wardrobe",
    sku: "WD-63",
    color: "Natural Oak",
    image: ["https://shop.test/a.jpg"],
    offers: {
      price: "299.00",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    width: { value: 43, unitCode: "INH" },
    depth: { value: 14, unitCode: "INH" },
    height: { value: 28, unitCode: "INH" },
  };
  return {
    url,
    title: "Oak wardrobe",
    html: `<html><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></html>`,
    text: "Oak wardrobe. Minimalist.",
    images: [{ url: "https://shop.test/a.jpg", alt: null }],
  };
};

const diagramPage = (url: string): PageContent => ({
  url,
  title: "Mystery cabinet",
  html: "<html><body>Mystery cabinet</body></html>",
  text: "Mystery cabinet. Minimalist natural oak. $199.00. No sizes printed here.",
  images: [
    { url: `${url}/hero.jpg`, alt: "cabinet" },
    { url: `${url}/dimensions.jpg`, alt: "dimensions" },
  ],
});

const diagramReadings: AxisReading[] = [
  { value: 43, unit: "in", axis: "width", subject: "overall", label: '43"' },
  { value: 12, unit: "in", axis: "width", subject: "component", label: '12"' },
  { value: 28, unit: "in", axis: "height", subject: "overall", label: '28"' },
  { value: 14, unit: "in", axis: "depth", subject: "overall", label: '14"' },
];

interface Counters {
  searches: string[][];
  extractions: number;
  diagrams: number;
  persisted: number;
}

function deps(
  pages: Record<string, PageContent>,
  overrides: Partial<PipelineDeps> = {},
): { deps: PipelineDeps; counters: Counters } {
  const counters: Counters = {
    searches: [],
    extractions: 0,
    diagrams: 0,
    persisted: 0,
  };
  const base: PipelineDeps = {
    search: async (_query, _count, includeDomains) => {
      counters.searches.push(includeDomains);
      return Object.keys(pages).map((url) => ({ url, title: null }));
    },
    fetchPage: async (url) => pages[url] ?? null,
    fetchContents: async () => [],
    fetchJson: async () => ({}),
    extractListing: async (page) => {
      counters.extractions += 1;
      const price = page.text.match(/\$(\d+(?:\.\d{2})?)/);
      return {
        name: page.title,
        variant: "Natural Oak",
        priceCents: price ? Math.round(Number(price[1]) * 100) : null,
        availability: "available",
        tags: ["minimalist"],
        imageUrl: page.images[0]?.url ?? null,
      };
    },
    readDiagram: async (images) => {
      counters.diagrams += 1;
      return { readings: diagramReadings, imageUrl: images[0]?.url ?? null };
    },
    persist: async (products) => {
      counters.persisted += products.length;
    },
    ...overrides,
  };
  return { deps: base, counters };
}

const pagesFrom = (list: PageContent[]) =>
  Object.fromEntries(list.map((page) => [page.url, page]));

describe("the search pipeline", () => {
  it("returns ranked candidates with dimensions from page text", async () => {
    const pages = pagesFrom([
      specPage("https://a.test/products/low-oak-cabinet"),
      specPage("https://b.test/products/oak-cabinet-low"),
    ]);
    const context = deps(pages);
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].product.measurement.evidence.kind).toBe(
      "spec-text",
    );
    expect(context.counters.diagrams).toBe(0);
    expect(context.counters.persisted).toBe(result.candidates.length);
  });

  it("prefers structured merchant data and skips the model", async () => {
    const context = deps(
      pagesFrom([jsonLdPage("https://c.test/products/oak-wardrobe")]),
    );
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates[0].product.priceCents).toBe(29900);
    expect(result.candidates[0].product.measurement.evidence.kind).toBe(
      "structured",
    );
    expect(context.counters.extractions).toBe(0);
  });

  it("reads a drawing only when the text was silent", async () => {
    const context = deps(
      pagesFrom([diagramPage("https://d.test/products/mystery-cabinet")]),
    );
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(context.counters.diagrams).toBe(1);
    expect(result.candidates[0].product.measurement.evidence.kind).toBe(
      "image",
    );
    expect(
      result.candidates[0].product.measurement.dimensions?.width,
    ).toBeCloseTo(1.092, 2);
  });

  it("stops reading drawings once enough candidates fit", async () => {
    const context = deps(
      pagesFrom([
        specPage("https://a.test/products/low-oak-cabinet"),
        diagramPage("https://d.test/products/mystery-cabinet"),
        diagramPage("https://e.test/products/second-mystery-cabinet"),
      ]),
    );
    await runSearch(makeTask(), context.deps, { minTierHits: 1, target: 2 });
    expect(context.counters.diagrams).toBe(1);
  });

  it("falls back to the open web when the tier is thin", async () => {
    const context = deps(
      pagesFrom([specPage("https://a.test/products/low-oak-cabinet")]),
    );
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 6,
    });
    expect(context.counters.searches[0].length).toBeGreaterThan(0);
    expect(context.counters.searches[1]).toEqual([]);
    expect(result.failures.some((f) => f.detail.includes("open web"))).toBe(
      true,
    );
  });

  it("reports an empty search instead of failing", async () => {
    const context = deps({}, { search: async () => [] });
    const result = await runSearch(makeTask(), context.deps);
    expect(result.candidates).toEqual([]);
    expect(result.explanation).toContain("No storage listings");
  });

  it("keeps going when one page cannot be read", async () => {
    const pages = pagesFrom([
      specPage("https://a.test/products/low-oak-cabinet"),
    ]);
    const context = deps(pages, {
      search: async () => [
        { url: "https://a.test/products/low-oak-cabinet", title: null },
        { url: "https://blocked.test/products/hidden-cabinet", title: null },
      ],
    });
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates).toHaveLength(1);
    expect(
      result.failures.some((f) => f.detail.includes("could not be read")),
    ).toBe(true);
  });

  it("survives a model that throws", async () => {
    const context = deps(
      pagesFrom([specPage("https://a.test/products/low-oak-cabinet")]),
      {
        extractListing: async () => {
          throw new Error("rate limited");
        },
      },
    );
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.failures.some((f) => f.detail.includes("rate limited"))).toBe(
      true,
    );
  });

  it("drops a listing the page priced above the ceiling", async () => {
    const context = deps(
      pagesFrom([specPage("https://a.test/products/low-oak-cabinet")]),
    );
    const result = await runSearch(
      makeTask({ maxPriceCents: 10000 }),
      context.deps,
      { minTierHits: 1 },
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.failures.some((f) => f.detail.includes("ceiling"))).toBe(
      true,
    );
  });
});

describe("searching several categories at once", () => {
  it("returns one result per task, in order", async () => {
    const context = deps(
      pagesFrom([specPage("https://a.test/products/low-oak-cabinet")]),
    );
    const results = await runSearches(
      [
        makeTask({ category: "storage", query: "oak cabinet" }),
        makeTask({ category: "lighting", query: "arc lamp" }),
      ],
      context.deps,
      { minTierHits: 1 },
    );
    expect(results.map((result) => result.category)).toEqual([
      "storage",
      "lighting",
    ]);
  });

  it("carries the gallery through to each candidate", async () => {
    const context = deps(
      pagesFrom([specPage("https://a.test/products/low-oak-cabinet")]),
    );
    const [result] = await runSearches([makeTask()], context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates[0].product.images.length).toBeGreaterThan(0);
    expect(result.candidates[0].product.imageUrl).toBe(
      result.candidates[0].product.images[0],
    );
  });
});

describe("explaining a silent page", () => {
  it("tells the caller why a size could not be read", async () => {
    const silent: PageContent = {
      url: "https://f.test/products/unordered-shelf",
      title: "Unordered shelf",
      html: "<html><body>Unordered shelf</body></html>",
      text: 'Unordered shelf. Minimalist natural oak. $199.00. 31 1/2x11x41 3/4"',
      images: [],
    };
    const context = deps(pagesFrom([silent]));
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    expect(result.candidates[0].product.measurement.dimensions).toBeNull();
    expect(result.failures.some((f) => f.detail.includes("order"))).toBe(true);
  });

  it("reports each distinct reason once", async () => {
    const context = deps(
      pagesFrom([
        diagramPage("https://d.test/products/mystery-cabinet"),
        diagramPage("https://e.test/products/second-mystery-cabinet"),
      ]),
    );
    const result = await runSearch(makeTask(), context.deps, {
      minTierHits: 1,
    });
    const details = result.failures.map((f) => `${f.stage}:${f.detail}`);
    expect(new Set(details).size).toBe(details.length);
  });
});

describe("a listing the model could not name", () => {
  it("takes the name from the page title rather than dropping the product", async () => {
    const page = specPage("https://a.test/products/low-oak-cabinet");
    const context = deps(pagesFrom([page]), {
      extractListing: async () => ({
        name: null,
        variant: "Natural Oak",
        priceCents: 24900,
        availability: "available",
        tags: [],
        imageUrl: null,
      }),
    });
    const result = await runSearch(makeTask(), context.deps, { minTierHits: 1 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].product.name).toBe("Low oak cabinet");
  });
});
