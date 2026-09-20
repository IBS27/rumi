import type { Category, Measurement, SearchFailure } from "../contracts";
import {
  completeDimensions,
  completeFlat,
  mergeReadings,
  parseDimensionText,
  selectOverall,
  type AxisReading,
  type Reading,
} from "./dimensions";
import { shortlistDiagramImages, type ImageRef } from "./images";

// Dimensions are resolved cheapest first. Every stage but the last is free, so a model
// only ever looks at a picture when the page refused to say.

export type DiagramReader = (
  images: ImageRef[],
) => Promise<{ readings: AxisReading[]; imageUrl: string | null }>;

export interface DimensionSources {
  category: Category;
  /** The listing's name. A bed's size is usually stated here. */
  name?: string | null;
  /** Labelled lines rebuilt from machine-readable merchant data. */
  structuredText: string | null;
  /** Page or description text, as printed. */
  pageText: string;
  images: ImageRef[];
  readDiagram?: DiagramReader;
}

export interface ResolvedDimensions {
  measurement: Measurement;
  failures: SearchFailure[];
  usedVision: boolean;
}

// A fresh object each time: a shared one would be embedded in every candidate, where a
// later edit to its evidence would rewrite history for all of them.
const unknown = (): Measurement => ({
  dimensions: null,
  source: "unknown",
  evidence: { kind: "none", detail: null },
});

const EMPTY_READING: Reading = {
  values: { width: null, height: null, depth: null },
  detail: null,
  issue: null,
};

function known(
  reading: Reading,
  kind: "structured" | "spec-text" | "image" | "mixed",
  category: Category,
): Measurement | null {
  // A flat piece (rug, art, curtain) is complete with two axes.
  const dimensions = completeDimensions(completeFlat(reading.values, category));
  if (!dimensions) return null;
  // Extracted dimensions are never "confirmed": only a person measuring is.
  return {
    dimensions,
    source: "estimated",
    evidence: { kind, detail: reading.detail },
  };
}

const hasAny = (reading: Reading) =>
  Object.values(reading.values).some((value) => value !== null);

// Mattress sizes are standard; a frame adds a few centimetres around them.
// Bed pages list every size in one table, which no text parser can read as a
// single measurement, but the listing's name says which size this is.
const BED_SIZES: [RegExp, { width: number; depth: number }][] = [
  [/\bcal(ifornia)?[ -]king\b/i, { width: 1.83, depth: 2.13 }],
  [/\bking\b/i, { width: 1.93, depth: 2.03 }],
  [/\bqueen\b/i, { width: 1.52, depth: 2.03 }],
  [/\b(full|double)\b/i, { width: 1.37, depth: 1.91 }],
  [/\btwin xl\b/i, { width: 0.97, depth: 2.03 }],
  [/\b(twin|single)\b/i, { width: 0.97, depth: 1.91 }],
];
const FRAME_ALLOWANCE = 0.08;
// A typical headboard height when the page does not say.
const BED_HEIGHT = 1.0;

function bedFromName(
  sources: DimensionSources,
  partial: Reading,
): Measurement | null {
  if (!/\bbed\b/i.test(sources.category) || /bedside|bench/i.test(sources.category))
    return null;
  const name = sources.name ?? "";
  const matches = BED_SIZES.filter(([pattern]) => pattern.test(name));
  // Exactly one size in the name; "Twin/Full/Queen" is a variant list.
  if (matches.length !== 1) return null;
  const [, size] = matches[0];
  return {
    dimensions: {
      width: partial.values.width ?? size.width + FRAME_ALLOWANCE,
      depth: partial.values.depth ?? size.depth + FRAME_ALLOWANCE,
      height: partial.values.height ?? BED_HEIGHT,
    },
    source: "estimated",
    evidence: {
      kind: "spec-text",
      detail: `Standard ${name.match(matches[0][0])?.[0]} size from the listing name.`,
    },
  };
}

export async function resolveDimensions(
  sources: DimensionSources,
): Promise<ResolvedDimensions> {
  const failures: SearchFailure[] = [];
  const note = (detail: string | null) => {
    if (detail) failures.push({ stage: "dimensions", detail });
  };

  const structured = sources.structuredText
    ? parseDimensionText(sources.structuredText, sources.category)
    : EMPTY_READING;
  const fromStructured = known(structured, "structured", sources.category);
  if (fromStructured)
    return { measurement: fromStructured, failures, usedVision: false };
  note(structured.issue);

  const text = parseDimensionText(sources.pageText, sources.category);
  const fromText = known(text, "spec-text", sources.category);
  if (fromText) return { measurement: fromText, failures, usedVision: false };
  note(text.issue);

  // Whatever the two text stages did find is still useful: it checks the diagram.
  const partial = hasAny(structured) ? structured : text;

  const standardBed = bedFromName(sources, partial);
  if (standardBed)
    return { measurement: standardBed, failures, usedVision: false };

  if (!sources.readDiagram || sources.images.length === 0) {
    // Without a reader this is the cheap pass, which defers to the drawing stage; with
    // one, there is genuinely nothing left to look at.
    if (sources.images.length === 0)
      failures.push({
        stage: "dimensions",
        detail: "The page states no dimensions and has no image to read.",
      });
    return { measurement: unknown(), failures, usedVision: false };
  }

  const shortlist = shortlistDiagramImages(sources.images);
  const { readings, imageUrl } = await sources.readDiagram(shortlist);
  if (readings.length === 0) {
    failures.push({
      stage: "dimensions",
      detail: "No image printed measurements.",
    });
    return { measurement: unknown(), failures, usedVision: true };
  }

  const diagram = selectOverall(readings, sources.category);
  note(diagram.issue);
  const merged = mergeReadings(partial, diagram);
  note(merged.issue);
  const measurement =
    known(merged, hasAny(partial) ? "mixed" : "image", sources.category) ??
    unknown();
  if (measurement.evidence.detail === null && measurement.dimensions !== null)
    measurement.evidence.detail = imageUrl;
  if (!measurement.dimensions)
    failures.push({
      stage: "dimensions",
      detail: "The diagram did not produce a usable size.",
    });
  return { measurement, failures, usedVision: true };
}
