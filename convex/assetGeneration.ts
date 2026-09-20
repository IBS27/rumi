import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { Dimensions } from "../shared/contracts";
import {
  imageViewRoleSchema,
  parametricModelSchema,
  parametricPartSchema,
  type ParametricModel,
} from "../shared/assets/model";

const MAX_GALLERY_IMAGES = 8;
const MAX_SELECTED_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const imageSelectionSchema = z.object({
  dimensionImageIndex: z.number().int().min(0).max(7).nullable(),
  selected: z
    .array(
      z.object({
        index: z.number().int().min(0).max(7),
        role: imageViewRoleSchema,
      }),
    )
    .min(1)
    .max(MAX_SELECTED_IMAGES),
});

const modelDraftSchema = z.object({
  label: z.string().trim().min(1).max(160),
  parts: z.array(parametricPartSchema).min(1).max(64),
  confidence: z.number().min(0).max(1),
  notes: z.array(z.string().trim().min(1).max(240)).max(8),
});

export interface AssetGenerationInput {
  name: string;
  category: string;
  dimensions: Dimensions;
  imageUrls: string[];
}

interface LoadedImage {
  url: string;
  data: Uint8Array;
  mediaType: string;
}

async function loadImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<LoadedImage | null> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "image/*",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      },
    });
    if (!response.ok) return null;
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) return null;
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) return null;
    return { url, data, mediaType };
  } catch {
    return null;
  }
}

async function selectProductViews(
  model: LanguageModel,
  loaded: LoadedImage[],
): Promise<Array<LoadedImage & { role: z.infer<typeof imageViewRoleSchema> }>> {
  const galleryContent = loaded.flatMap((image, index) => [
    { type: "text" as const, text: `Gallery image ${index}` },
    {
      type: "image" as const,
      image: image.data,
      mediaType: image.mediaType,
    },
  ]);
  const { object } = await generateObject({
    model,
    schema: imageSelectionSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Select exactly ${Math.min(MAX_SELECTED_IMAGES, loaded.length)} images from this product gallery for 3D reconstruction.`,
              "If any image contains printed overall product dimensions or a measurement drawing, it must be selected with role dimensions.",
              "Use the remaining slots for genuinely different views of the object: prefer front, side, back, three-quarter, then top or detail.",
              "Do not choose repeated crops or several images from the same angle.",
              "dimensionImageIndex is the gallery index of the best measurement drawing, or null only when no gallery image contains printed dimensions.",
              "Every selected index and role must be unique.",
            ].join(" "),
          },
          ...galleryContent,
        ],
      },
    ],
  });

  const expected = Math.min(MAX_SELECTED_IMAGES, loaded.length);
  if (object.selected.length !== expected)
    throw new Error(
      `Image selection returned ${object.selected.length}; expected ${expected}.`,
    );
  if (new Set(object.selected.map((entry) => entry.index)).size !== expected)
    throw new Error("Image selection returned a duplicate gallery image.");
  if (new Set(object.selected.map((entry) => entry.role)).size !== expected)
    throw new Error("Image selection returned duplicate viewing angles.");
  if (object.selected.some((entry) => entry.index >= loaded.length))
    throw new Error("Image selection referenced a missing gallery image.");
  if (object.dimensionImageIndex !== null) {
    const dimension = object.selected.find(
      (entry) => entry.index === object.dimensionImageIndex,
    );
    if (!dimension || dimension.role !== "dimensions")
      throw new Error(
        "The dimension drawing was not included in the selected images.",
      );
  } else if (object.selected.some((entry) => entry.role === "dimensions")) {
    throw new Error(
      "Image selection labelled a dimension view inconsistently.",
    );
  }

  return object.selected.map((entry) => ({
    ...loaded[entry.index],
    role: entry.role,
  }));
}

export async function generateParametricModel(
  model: LanguageModel,
  input: AssetGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ParametricModel> {
  const uniqueUrls = [...new Set(input.imageUrls)].slice(0, MAX_GALLERY_IMAGES);
  const loaded = (
    await Promise.all(uniqueUrls.map((url) => loadImage(url, fetchImpl)))
  ).filter((image): image is NonNullable<typeof image> => image !== null);
  if (loaded.length === 0)
    throw new Error("No usable product images could be downloaded.");

  const selected = await selectProductViews(model, loaded);

  const { width, height, depth } = input.dimensions;
  const { object } = await generateObject({
    model,
    schema: modelDraftSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Build a compact parametric Three.js description of this ${input.category}: ${input.name}.`,
              `Its application-provided outer size is ${width} m wide, ${height} m high, and ${depth} m deep.`,
              "All photos show the same product. Represent only visible structural parts with boxes, cylinders, and spheres.",
              "Coordinates are normalized to the verified outer size: X is width from -0.5 to 0.5, Y is height from 0 at the floor to 1 at the top, and Z is depth from -0.5 to 0.5.",
              "Part sizes and positions use those normalized coordinates. A part resting on the floor has position.y equal to half its size.y.",
              "Three.js cylinders point along Y before rotation. Rotations are XYZ Euler radians in normalized space: scale the primitive by its normalized size, rotate it, then translate it. The application applies the outer size to the entire scene afterward.",
              "Match the silhouette, proportions, visible openings, legs, supports, doors, drawers, cushions, and main material colors.",
              "Do not invent hidden interiors, branding, tiny hardware, text, or decorative detail that the photos do not establish.",
              "Use as few parts as possible while keeping the object recognizable. Keep the entire rotated geometry of every part inside X/Z [-0.5, 0.5] and Y [0, 1]; no overhang or below-floor parts are allowed.",
            ].join(" "),
          },
          ...selected.flatMap((image) => [
            {
              type: "text" as const,
              text: `Selected ${image.role} view`,
            },
            {
              type: "image" as const,
              image: image.data,
              mediaType: image.mediaType,
            },
          ]),
        ],
      },
    ],
  });

  // Dimensions and source URLs come from validated application data, never from the
  // model. The final parse enforces bounds and unique part IDs before rendering.
  return parametricModelSchema.parse({
    version: 1,
    label: object.label,
    dimensions: input.dimensions,
    sourceImages: selected.map((image) => image.url),
    sourceViews: selected.map((image) => ({
      url: image.url,
      role: image.role,
    })),
    parts: object.parts,
    confidence: object.confidence,
    notes: object.notes,
  });
}
