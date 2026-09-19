import type { Category, Measurement, SearchFailure } from "../contracts";
import {
  completeDimensions,
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
): Measurement | null {
  const dimensions = completeDimensions(reading.values);
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
  const fromStructured = known(structured, "structured");
  if (fromStructured)
    return { measurement: fromStructured, failures, usedVision: false };
  note(structured.issue);

  const text = parseDimensionText(sources.pageText, sources.category);
  const fromText = known(text, "spec-text");
  if (fromText) return { measurement: fromText, failures, usedVision: false };
  note(text.issue);

  // Whatever the two text stages did find is still useful: it checks the diagram.
  const partial = hasAny(structured) ? structured : text;

  if (!sources.readDiagram || sources.images.length === 0) {
    failures.push({
      stage: "dimensions",
      detail: "No dimensions in the page text and no image to read.",
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
    known(merged, hasAny(partial) ? "mixed" : "image") ?? unknown();
  if (measurement.evidence.detail === null && measurement.dimensions !== null)
    measurement.evidence.detail = imageUrl;
  if (!measurement.dimensions)
    failures.push({
      stage: "dimensions",
      detail: "The diagram did not produce a usable size.",
    });
  return { measurement, failures, usedVision: true };
}
