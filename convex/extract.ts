import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import {
  productSchema,
  type ProductCandidate,
  type SearchTask,
} from "../shared/contracts";
import {
  merchantFor,
  productIdFor,
  type ExaPageContent,
} from "../shared/search";
import { formatMoney } from "../shared/budget";

const TO_METERS = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  ft: 0.3048,
} as const;

const extractionSchema = z.object({
  name: z.string().min(1),
  variant: z
    .string()
    .min(1)
    .describe("The specific purchasable variant, such as size or finish."),
  priceUsd: z.number().nonnegative().nullable(),
  dimensions: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      depth: z.number().positive(),
    })
    .nullable(),
  dimensionUnit: z.enum(["m", "cm", "mm", "in", "ft"]).nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .describe("Dominant color as a hex value, from the page or a best guess."),
  imageUrl: z.string().nullable(),
  availability: z.enum(["available", "unavailable", "unknown"]),
  tags: z.array(z.string()),
});

type Extraction = z.infer<typeof extractionSchema>;

function normalize(
  extracted: Extraction,
  sourceUrl: string,
  task: SearchTask,
): ProductCandidate | null {
  if (!z.url().safeParse(sourceUrl).success) return null;
  if (extracted.priceUsd === null) return null;
  const scale = extracted.dimensionUnit
    ? TO_METERS[extracted.dimensionUnit]
    : null;
  const dimensions =
    extracted.dimensions && scale
      ? {
          width: Math.round(extracted.dimensions.width * scale * 1000) / 1000,
          height: Math.round(extracted.dimensions.height * scale * 1000) / 1000,
          depth: Math.round(extracted.dimensions.depth * scale * 1000) / 1000,
        }
      : null;
  const candidate = {
    id: productIdFor(sourceUrl, extracted.variant),
    variantId: extracted.variant,
    name: extracted.name,
    category: task.category,
    merchant: merchantFor(sourceUrl),
    sourceUrl,
    imageUrl:
      extracted.imageUrl && z.url().safeParse(extracted.imageUrl).success
        ? extracted.imageUrl
        : null,
    priceCents: Math.round(extracted.priceUsd * 100),
    currency: "USD",
    measurement: {
      dimensions,
      source: dimensions ? ("estimated" as const) : ("unknown" as const),
    },
    color: extracted.color ?? "#9ca3af",
    tags: extracted.tags,
    availability: extracted.availability,
    assetId: null,
    synthetic: false,
  };
  const parsed = productSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export async function extractProduct(
  model: LanguageModel,
  page: ExaPageContent,
  task: SearchTask,
): Promise<ProductCandidate | null> {
  const { object } = await generateObject({
    model,
    schema: extractionSchema,
    prompt: [
      `Extract one purchasable ${task.category} product variant from this product page.`,
      `Price ceiling: ${formatMoney(task.maxPriceCents)}.`,
      task.styleTerms.length
        ? `Target style: ${task.styleTerms.join(", ")}.`
        : null,
      `Page URL: ${page.url}`,
      `Page title: ${page.title ?? "untitled"}`,
      "Page text:",
      page.text,
      "Report dimensions exactly as printed, with their unit. Use null for price or dimensions that are absent. Use 'unknown' availability when the page does not state stock.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  return normalize(object, page.url, task);
}
