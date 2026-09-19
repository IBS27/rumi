import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { SearchTask } from "../shared/contracts";
import type { ListingFacts } from "../shared/search/candidate";
import type { AxisReading } from "../shared/search/dimensions";
import type { ImageRef } from "../shared/search/images";
import { diagramReadTargets } from "../shared/search/images";
import type { PageContent } from "../shared/search/page";
import { formatMoney } from "../shared/budget";

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
      `Price ceiling: ${formatMoney(task.maxPriceCents)}.`,
      "Report only what the page states. Use null where it is silent.",
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
          .describe("The measurement exactly as printed, e.g. 63\""),
      }),
    )
    .max(40),
});

export async function readDiagram(
  model: LanguageModel,
  images: ImageRef[],
): Promise<{ readings: AxisReading[]; imageUrl: string | null }> {
  const targets = diagramReadTargets(images);
  if (targets.length === 0) return { readings: [], imageUrl: null };
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
          ...targets.map((image) => ({
            type: "image" as const,
            image: new URL(image.url),
          })),
        ],
      },
    ],
  });
  if (!object.hasPrintedMeasurements)
    return { readings: [], imageUrl: targets[0]?.url ?? null };
  const readings: AxisReading[] = object.measurements
    .filter((item) => item.label.trim().length > 0)
    .map((item) => ({
      value: item.value,
      unit: item.unit,
      axis: item.axis,
      subject: item.subject,
      label: item.label,
    }));
  return { readings, imageUrl: targets[0]?.url ?? null };
}
