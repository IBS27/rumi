import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { SearchTask } from "../shared/contracts";
import type { ListingFacts } from "../shared/search/candidate";
import type { AxisReading } from "../shared/search/dimensions";
import type { ImageRef } from "../shared/search/images";
import { diagramReadTargets } from "../shared/search/images";
import type { PageContent } from "../shared/search/page";

// The only two places a model is used. Everything it returns is checked by code before
// it reaches a contract: prices, units, and axis selection are not its decisions.

const listingSchema = z.object({
  name: z.string().min(1).nullable(),
  variant: z
    .string()
    .nullable()
    .describe("The purchasable variant: size or finish, as the page names it."),
  priceUsd: z.number().nonnegative().nullable(),
  colorText: z
    .string()
    .nullable()
    .describe("The finish or color as the page words it, e.g. 'Natural Oak'."),
  availability: z.enum(["available", "unavailable", "unknown"]),
  tags: z.array(z.string()).max(12),
});

export async function extractListing(
  model: LanguageModel,
  page: PageContent,
  task: SearchTask,
): Promise<Partial<ListingFacts>> {
  const { object } = await generateObject({
    model,
    schema: listingSchema,
    prompt: [
      `Read this product page for one purchasable ${task.category}.`,
      "Report exactly what the page states, whatever the price: the ceiling is",
      "applied afterwards, so an expensive listing must still be reported in full.",
      "Use null only where the page is genuinely silent.",
      "Do not report dimensions; they are read separately.",
      `Page URL: ${page.url}`,
      `Page title: ${page.title ?? "untitled"}`,
      "Page text:",
      page.text.slice(0, 12000),
    ].join("\n"),
  });
  return {
    name: object.name,
    variant: object.variant,
    priceCents:
      object.priceUsd === null ? null : Math.round(object.priceUsd * 100),
    colorText: object.colorText,
    availability: object.availability,
    tags: object.tags,
  };
}

// A diagram carries many measurements and only three are the product. So the model
// enumerates everything printed and code selects; it is never asked for the answer.
const diagramSchema = z.object({
  hasPrintedMeasurements: z.boolean(),
  measurements: z
    .array(
      z.object({
        value: z.number().positive(),
        unit: z.enum(["in", "cm", "mm", "m", "ft"]),
        axis: z.enum(["width", "height", "depth", "unknown"]),
        subject: z.enum(["overall", "component", "unknown"]),
        label: z
          .string()
          .min(1)
          .describe('The measurement exactly as printed, e.g. 63"'),
      }),
    )
    .max(40),
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Providers fetch an image URL on their own terms and fail on hotlink protection or on
// a URL that turns out to be a page. Fetching it here, as a browser would, and sending
// the bytes removes both failures before a model call is spent.
async function loadImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ data: Uint8Array; mediaType: string } | null> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "image/*",
      },
    });
    if (!response.ok) return null;
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) return null;
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) return null;
    return { data, mediaType };
  } catch {
    return null;
  }
}

export async function readDiagram(
  model: LanguageModel,
  images: ImageRef[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ readings: AxisReading[]; imageUrl: string | null }> {
  const targets = diagramReadTargets(images);
  const loaded = (
    await Promise.all(
      targets.map(async (image) => ({
        image,
        file: await loadImage(image.url, fetchImpl),
      })),
    )
  ).filter(
    (
      entry,
    ): entry is { image: ImageRef; file: NonNullable<typeof entry.file> } =>
      entry.file !== null,
  );
  if (loaded.length === 0) return { readings: [], imageUrl: null };
  const { object } = await generateObject({
    model,
    schema: diagramSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "These images may be dimension drawings for one piece of furniture.",
              "List every measurement whose number is PRINTED in an image.",
              "Never estimate from the look of a photograph: if no measurement is",
              "printed, set hasPrintedMeasurements to false and return no items.",
              "Mark a measurement as 'overall' only when it spans the whole piece;",
              "interior openings, drawers and shelves are 'component'.",
              "Copy each number into label exactly as printed, with its unit mark.",
            ].join(" "),
          },
          ...loaded.map(({ file }) => ({
            type: "image" as const,
            image: file.data,
            mediaType: file.mediaType,
          })),
        ],
      },
    ],
  });
  const imageUrl = loaded[0].image.url;
  if (!object.hasPrintedMeasurements) return { readings: [], imageUrl };
  const readings: AxisReading[] = object.measurements
    .filter((item) => item.label.trim().length > 0)
    .map((item) => ({
      value: item.value,
      unit: item.unit,
      axis: item.axis,
      subject: item.subject,
      label: item.label,
    }));
  return { readings, imageUrl };
}
