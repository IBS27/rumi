import { describe, expect, it } from "bun:test";
import { MockLanguageModelV2 } from "ai/test";
import { extractListing, readDiagram } from "../convex/extract";
import type { PageContent } from "../shared/search/page";
import { makeTask } from "./helpers";

// The two model calls, exercised against a mocked provider: no API key, no network.

interface Call {
  prompt: unknown;
}

function model(answer: unknown) {
  const calls: Call[] = [];
  const instance = new MockLanguageModelV2({
    // Declared like a real vision provider, so image URLs are passed through rather
    // than downloaded by the SDK.
    supportedUrls: { "image/*": [/^https?:\/\/.*/] },
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt });
      return {
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text: JSON.stringify(answer) }],
        warnings: [],
      };
    },
  });
  return { instance, calls };
}

const page: PageContent = {
  url: "https://shop.test/products/oak-cabinet",
  title: "Low oak cabinet",
  html: null,
  text: "Low oak cabinet in natural oak. $249.",
  images: [],
};

describe("reading a listing", () => {
  it("converts the price to cents and keeps silence as null", async () => {
    const { instance, calls } = model({
      name: "Low oak cabinet",
      variant: "Natural Oak",
      priceUsd: 249,
      colorText: "Natural Oak",
      availability: "available",
      tags: ["minimalist"],
    });
    const facts = await extractListing(instance, page, makeTask());
    expect(facts.priceCents).toBe(24900);
    expect(facts.variant).toBe("Natural Oak");
    expect(calls).toHaveLength(1);
  });

  it("passes a missing price through as null rather than zero", async () => {
    const { instance } = model({
      name: "Low oak cabinet",
      variant: null,
      priceUsd: null,
      colorText: null,
      availability: "unknown",
      tags: [],
    });
    const facts = await extractListing(instance, page, makeTask());
    expect(facts.priceCents).toBeNull();
  });
});

const images = [
  { url: "https://shop.test/hero.jpg", alt: "cabinet" },
  { url: "https://shop.test/product-dimensions.jpg", alt: "dimensions" },
  { url: "https://shop.test/side.jpg", alt: null },
];

// Serves a small PNG for most URLs, hotlink-protection for one, and a page for another.
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const imageFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("blocked"))
    return new Response("forbidden", { status: 403 });
  if (url.includes("page"))
    return new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  return new Response(png, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}) as typeof fetch;

describe("reading a drawing", () => {
  it("returns nothing when the model reports no printed measurements", async () => {
    const { instance } = model({
      hasPrintedMeasurements: false,
      measurements: [
        {
          value: 40,
          unit: "in",
          axis: "width",
          subject: "overall",
          label: "guess",
        },
      ],
    });
    const result = await readDiagram(instance, images, imageFetch);
    expect(result.readings).toEqual([]);
  });

  it("returns every printed measurement for code to select from", async () => {
    const { instance } = model({
      hasPrintedMeasurements: true,
      measurements: [
        {
          value: 63,
          unit: "in",
          axis: "width",
          subject: "overall",
          label: '63"',
        },
        {
          value: 15,
          unit: "in",
          axis: "width",
          subject: "component",
          label: '15"',
        },
        {
          value: 70.9,
          unit: "in",
          axis: "height",
          subject: "overall",
          label: '70.9"',
        },
      ],
    });
    const result = await readDiagram(instance, images, imageFetch);
    expect(result.readings).toHaveLength(3);
    expect(result.readings[0]).toMatchObject({ value: 63, axis: "width" });
    expect(result.imageUrl).toContain("dimensions");
  });

  it("drops a measurement with no verbatim label", async () => {
    const { instance } = model({
      hasPrintedMeasurements: true,
      measurements: [
        {
          value: 63,
          unit: "in",
          axis: "width",
          subject: "overall",
          label: " ",
        },
      ],
    });
    expect(
      (await readDiagram(instance, images, imageFetch)).readings,
    ).toHaveLength(0);
  });

  it("sends only the named drawing, as bytes, not the whole gallery", async () => {
    const { instance, calls } = model({
      hasPrintedMeasurements: true,
      measurements: [],
    });
    const result = await readDiagram(instance, images, imageFetch);
    const content = (
      calls[0].prompt as {
        content: { type: string; data?: unknown; mediaType?: string }[];
      }[]
    )[0].content;
    const sent = content.filter((part) => part.type === "file");
    expect(sent).toHaveLength(1);
    expect(sent[0].mediaType).toBe("image/png");
    expect(sent[0].data).toBeInstanceOf(Uint8Array);
    expect(result.imageUrl).toContain("product-dimensions");
  });

  it("skips a hotlink-protected image and a URL that is really a page", async () => {
    const { instance, calls } = model({
      hasPrintedMeasurements: true,
      measurements: [],
    });
    const result = await readDiagram(
      instance,
      [
        { url: "https://shop.test/blocked-dimensions.jpg", alt: null },
        { url: "https://shop.test/page-dimensions", alt: null },
      ],
      imageFetch,
    );
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ readings: [], imageUrl: null });
  });

  it("never calls the model when there is nothing to look at", async () => {
    const { instance, calls } = model({});
    const result = await readDiagram(instance, [], imageFetch);
    expect(result).toEqual({ readings: [], imageUrl: null });
    expect(calls).toHaveLength(0);
  });
});
