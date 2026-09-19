import { describe, expect, it } from "bun:test";
import { resolveDimensions } from "../shared/search/cascade";
import type { AxisReading } from "../shared/search/dimensions";
import type { ImageRef } from "../shared/search/images";

const wardrobeReadings: AxisReading[] = [
  { value: 29.9, unit: "in", axis: "width", subject: "component", label: '29.9"' },
  { value: 63, unit: "in", axis: "width", subject: "overall", label: '63"' },
  { value: 39.4, unit: "in", axis: "height", subject: "component", label: '39.4"' },
  { value: 70.9, unit: "in", axis: "height", subject: "overall", label: '70.9"' },
  { value: 11.8, unit: "in", axis: "depth", subject: "component", label: '11.8"' },
  { value: 18.9, unit: "in", axis: "depth", subject: "overall", label: '18.9"' },
];

const images: ImageRef[] = [
  { url: "https://x.test/hero.jpg", alt: "wardrobe" },
  { url: "https://x.test/dimensions.jpg", alt: null },
];

function reader(readings: AxisReading[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    read: async (shortlist: ImageRef[]) => {
      calls += 1;
      return { readings, imageUrl: shortlist[0]?.url ?? null };
    },
  };
}

describe("dimension cascade", () => {
  it("uses merchant data and never opens an image", async () => {
    const vision = reader(wardrobeReadings);
    const result = await resolveDimensions({
      category: "storage",
      structuredText: "width: 63 in\ndepth: 18.9 in\nheight: 70.9 in",
      pageText: "Solid wood wardrobe.",
      images,
      readDiagram: vision.read,
    });
    expect(result.measurement.evidence.kind).toBe("structured");
    expect(result.measurement.dimensions?.width).toBeCloseTo(1.6, 2);
    expect(result.usedVision).toBe(false);
    expect(vision.calls).toBe(0);
  });

  it("falls back to the page specification without a model call", async () => {
    const vision = reader(wardrobeReadings);
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: 'Product Dimensions: 63"W x 18.9"D x 70.9"H',
      images,
      readDiagram: vision.read,
    });
    expect(result.measurement.evidence.kind).toBe("spec-text");
    expect(vision.calls).toBe(0);
  });

  it("reads the diagram when the page says nothing", async () => {
    const vision = reader(wardrobeReadings);
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: "Solid wood wardrobe with four doors.",
      images,
      readDiagram: vision.read,
    });
    expect(result.measurement.evidence.kind).toBe("image");
    expect(result.measurement.dimensions?.depth).toBeCloseTo(0.48, 2);
    expect(vision.calls).toBe(1);
  });

  it("completes a partial specification from the diagram", async () => {
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: 'Width: 63" Height: 70.9"',
      images,
      readDiagram: reader(wardrobeReadings).read,
    });
    expect(result.measurement.evidence.kind).toBe("mixed");
    expect(result.measurement.dimensions?.depth).toBeCloseTo(0.48, 2);
  });

  it("refuses to merge a diagram that contradicts the page", async () => {
    const contradicting = wardrobeReadings.map((item) =>
      item.label === '63"' ? { ...item, value: 40 } : item,
    );
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: 'Width: 63" Height: 70.9"',
      images,
      readDiagram: reader(contradicting).read,
    });
    expect(result.measurement.dimensions).toBeNull();
    expect(result.failures.some((f) => f.detail.includes("disagree"))).toBe(
      true,
    );
  });

  it("reports unknown when an image prints no measurements", async () => {
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: "Solid wood wardrobe.",
      images,
      readDiagram: reader([]).read,
    });
    expect(result.measurement.source).toBe("unknown");
    expect(result.measurement.evidence.kind).toBe("none");
    expect(result.failures.at(-1)?.detail).toContain("printed measurements");
  });

  it("reports unknown when there is nothing to read at all", async () => {
    const result = await resolveDimensions({
      category: "storage",
      structuredText: null,
      pageText: "Solid wood wardrobe.",
      images: [],
    });
    expect(result.measurement.dimensions).toBeNull();
    expect(result.usedVision).toBe(false);
  });
});
