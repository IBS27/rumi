import { describe, expect, it } from "bun:test";
import {
  completeDimensions,
  mergeReadings,
  parseDimensionText,
  selectOverall,
  withinRange,
  type AxisReading,
} from "../shared/search/dimensions";

const near = (value: number | null, expected: number) => {
  expect(value).not.toBeNull();
  expect(Math.abs((value as number) - expected)).toBeLessThan(0.006);
};

describe("dimension text", () => {
  it("reads inch dimensions written against each axis", () => {
    const reading = parseDimensionText(
      'Product Dimensions: 63"W x 18.9"D x 70.9"H',
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.depth, 0.48);
    near(reading.values.height, 1.801);
    expect(reading.issue).toBeNull();
    expect(reading.detail).toContain("63");
  });

  it("reads centimetres listed on separate lines", () => {
    const reading = parseDimensionText(
      "Specifications\nWidth: 160 cm\nDepth: 48 cm\nHeight: 180 cm",
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.depth, 0.48);
    near(reading.values.height, 1.8);
  });

  it("reads feet and inches", () => {
    const reading = parseDimensionText(
      "Width: 5'3\" | Height: 6 ft",
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.height, 1.829);
  });

  it("ignores packaging and shipping measurements", () => {
    const reading = parseDimensionText(
      'Package Dimensions: 70"W x 24"D x 80"H\nProduct Dimensions: 63"W x 18.9"D x 70.9"H',
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.height, 1.801);
  });

  it("uses a stated axis order for positional triples", () => {
    const reading = parseDimensionText(
      "Dimensions (W x D x H): 160 x 48 x 180 cm",
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.depth, 0.48);
    near(reading.values.height, 1.8);
  });

  it("refuses a positional triple with no stated order", () => {
    const reading = parseDimensionText(
      "Dimensions: 160 x 48 x 180 cm",
      "storage",
    );
    expect(completeDimensions(reading.values)).toBeNull();
    expect(reading.issue).toContain("order");
  });

  it("infers a missing unit from the plausible range", () => {
    const reading = parseDimensionText(
      "Width: 63, Depth: 18.9, Height: 70.9",
      "storage",
    );
    near(reading.values.width, 1.6);
    near(reading.values.height, 1.801);
    expect(reading.detail).toContain("in");
  });

  it("leaves an ambiguous unit unresolved", () => {
    const reading = parseDimensionText(
      "Width: 40, Depth: 30, Height: 50",
      "storage",
    );
    expect(completeDimensions(reading.values)).toBeNull();
    expect(reading.issue).toContain("unit");
  });

  it("returns nothing for text without measurements", () => {
    const reading = parseDimensionText("Solid oak, hand finished.", "storage");
    expect(completeDimensions(reading.values)).toBeNull();
  });
});

// The wardrobe diagram: fifteen printed measurements, three of which are the product.
const wardrobe: AxisReading[] = [
  { value: 15, unit: "in", axis: "width", subject: "component", label: '15"' },
  {
    value: 29.9,
    unit: "in",
    axis: "width",
    subject: "component",
    label: '29.9"',
  },
  { value: 15, unit: "in", axis: "width", subject: "component", label: '15"' },
  { value: 63, unit: "in", axis: "width", subject: "overall", label: '63"' },
  {
    value: 12.8,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '12.8"',
  },
  {
    value: 39.4,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '39.4"',
  },
  {
    value: 13.6,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '13.6"',
  },
  {
    value: 8.7,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '8.7"',
  },
  {
    value: 27.8,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '27.8"',
  },
  {
    value: 70.9,
    unit: "in",
    axis: "height",
    subject: "overall",
    label: '70.9"',
  },
  {
    value: 9.8,
    unit: "in",
    axis: "depth",
    subject: "component",
    label: '9.8"',
  },
  {
    value: 18.9,
    unit: "in",
    axis: "depth",
    subject: "overall",
    label: '18.9"',
  },
  {
    value: 29.1,
    unit: "in",
    axis: "width",
    subject: "component",
    label: '29.1"',
  },
  {
    value: 11.8,
    unit: "in",
    axis: "depth",
    subject: "component",
    label: '11.8"',
  },
  {
    value: 4.7,
    unit: "in",
    axis: "height",
    subject: "component",
    label: '4.7"',
  },
];

describe("dimension diagram", () => {
  it("selects the overall triple out of fifteen measurements", () => {
    const reading = selectOverall(wardrobe, "storage");
    near(reading.values.width, 1.6);
    near(reading.values.height, 1.801);
    near(reading.values.depth, 0.48);
    expect(reading.issue).toBeNull();
  });

  it("ignores a mislabelled subject, because a part cannot exceed the whole", () => {
    const mislabelled = wardrobe.map((item) => ({
      ...item,
      subject: "unknown" as const,
    }));
    near(selectOverall(mislabelled, "storage").values.width, 1.6);
  });

  it("refuses an image showing two product sizes", () => {
    const twoSizes: AxisReading[] = [
      ...wardrobe,
      {
        value: 47,
        unit: "in",
        axis: "width",
        subject: "overall",
        label: '47"',
      },
    ];
    const reading = selectOverall(twoSizes, "storage");
    expect(completeDimensions(reading.values)).toBeNull();
    expect(reading.issue).toContain("two");
  });

  it("refuses a reading with an axis missing", () => {
    const reading = selectOverall(
      wardrobe.filter((item) => item.axis !== "depth"),
      "storage",
    );
    expect(completeDimensions(reading.values)).toBeNull();
  });

  it("refuses a reading outside the plausible range for the category", () => {
    const giant: AxisReading[] = [
      { value: 5, unit: "m", axis: "width", subject: "overall", label: "5 m" },
      { value: 5, unit: "m", axis: "height", subject: "overall", label: "5 m" },
      { value: 5, unit: "m", axis: "depth", subject: "overall", label: "5 m" },
    ];
    expect(selectOverall(giant, "lighting").issue).toContain("plausible");
  });

  it("knows plausible ranges per category", () => {
    expect(
      withinRange("lighting", { width: 0.4, height: 1.5, depth: 0.4 }),
    ).toBe(true);
    expect(withinRange("lighting", { width: 0.4, height: 5, depth: 0.4 })).toBe(
      false,
    );
    expect(withinRange("rug", { width: 1.6, height: 0.02, depth: 2.2 })).toBe(
      true,
    );
  });
});

describe("merging a text reading with a diagram", () => {
  const text = {
    values: { width: 1.6, height: 1.801, depth: null },
    detail: '63"W x 70.9"H',
    issue: null,
  };

  it("fills the missing axis when the known axes agree", () => {
    const merged = mergeReadings(text, selectOverall(wardrobe, "storage"));
    near(merged.values.depth, 0.48);
    near(merged.values.width, 1.6);
    expect(merged.issue).toBeNull();
  });

  it("discards the whole diagram when a known axis disagrees", () => {
    const disagreeing = selectOverall(
      wardrobe.map((item) =>
        item.label === '63"' ? { ...item, value: 47 } : item,
      ),
      "storage",
    );
    const merged = mergeReadings(text, disagreeing);
    expect(merged.values.depth).toBeNull();
    expect(merged.issue).toContain("disagree");
  });

  it("keeps the text reading when there is no diagram", () => {
    const merged = mergeReadings(text, {
      values: { width: null, height: null, depth: null },
      detail: null,
      issue: "no printed measurements",
    });
    near(merged.values.width, 1.6);
    expect(merged.values.depth).toBeNull();
  });
});

describe("printed fractions and page furniture", () => {
  it("reads fractional inches", () => {
    const reading = parseDimensionText(
      'Width: 31 1/2" Depth: 11" Height: 41 3/4"',
      "storage",
    );
    near(reading.values.width, 0.8);
    near(reading.values.depth, 0.279);
    near(reading.values.height, 1.061);
  });

  it("reads a lone fraction", () => {
    near(
      parseDimensionText('Height: 1/2" Width: 30" Depth: 36"', "rug").values
        .height,
      0.013,
    );
  });

  it("ignores filter menus that advertise ranges and counts", () => {
    const reading = parseDimensionText(
      'Width 72" to 86" (88)\nOrientation (14)',
      "storage",
    );
    expect(reading.values.width).toBeNull();
  });

  it("still refuses an unordered fractional triple", () => {
    const reading = parseDimensionText('31 1/2x11x41 3/4 "', "storage");
    expect(completeDimensions(reading.values)).toBeNull();
    expect(reading.issue).toContain("order");
  });
});
