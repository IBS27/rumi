import { z } from "zod";

const physicalDimensionsSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
});

const rotationSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

// Astra describes an object as a small assembly of safe Three.js primitives. Positions
// and sizes are normalized against the product's verified outer dimensions, so a model
// always occupies the same physical footprint as the catalog item in the room editor.
export const primitiveShapeSchema = z.enum(["box", "cylinder", "sphere"]);
export const materialKindSchema = z.enum([
  "matte",
  "wood",
  "metal",
  "glass",
  "fabric",
]);

export const imageViewRoleSchema = z.enum([
  "dimensions",
  "front",
  "side",
  "back",
  "three-quarter",
  "top",
  "detail",
]);

const normalizedSizeSchema = z.object({
  x: z.number().positive().max(1.5),
  y: z.number().positive().max(1.5),
  z: z.number().positive().max(1.5),
});

const normalizedPositionSchema = z.object({
  x: z.number().min(-0.75).max(0.75),
  y: z.number().min(-0.25).max(1.25),
  z: z.number().min(-0.75).max(0.75),
});

export const parametricPartSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  shape: primitiveShapeSchema,
  size: normalizedSizeSchema,
  position: normalizedPositionSchema,
  // Astra commonly omits a rotation after explicitly deciding that every part is
  // axis-aligned. Treat omission as the identity transform; non-zero rotations remain
  // explicit and validated.
  rotation: rotationSchema.default({ x: 0, y: 0, z: 0 }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  material: materialKindSchema,
});

export const parametricModelSchema = z
  .object({
    version: z.literal(1),
    label: z.string().trim().min(1).max(160),
    dimensions: physicalDimensionsSchema,
    sourceImages: z.array(z.url()).min(1).max(4),
    sourceViews: z
      .array(
        z.object({
          url: z.url(),
          role: imageViewRoleSchema,
        }),
      )
      .min(1)
      .max(4),
    parts: z.array(parametricPartSchema).min(1).max(64),
    confidence: z.number().min(0).max(1),
    notes: z.array(z.string().trim().min(1).max(240)).max(8),
  })
  .superRefine((model, ctx) => {
    if (
      model.sourceViews.length !== model.sourceImages.length ||
      model.sourceViews.some(
        (view, index) => view.url !== model.sourceImages[index],
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceViews"],
        message: "Source views must describe each source image in order",
      });
    if (new Set(model.sourceViews.map((view) => view.role)).size !== model.sourceViews.length)
      ctx.addIssue({
        code: "custom",
        path: ["sourceViews"],
        message: "Source images must use distinct viewing roles",
      });

    const ids = new Set<string>();
    for (const [index, part] of model.parts.entries()) {
      if (ids.has(part.id))
        ctx.addIssue({
          code: "custom",
          path: ["parts", index, "id"],
          message: "Part IDs must be unique",
        });
      ids.add(part.id);

      // Allow a little overlap and trim for angled/rounded parts, but reject a model
      // whose declared pieces sit substantially outside its normalized product bounds.
      const halfX = part.size.x / 2;
      const halfY = part.size.y / 2;
      const halfZ = part.size.z / 2;
      if (Math.abs(part.position.x) + halfX > 0.9)
        ctx.addIssue({
          code: "custom",
          path: ["parts", index, "position", "x"],
          message: "Part exceeds the normalized width",
        });
      if (part.position.y - halfY < -0.2 || part.position.y + halfY > 1.2)
        ctx.addIssue({
          code: "custom",
          path: ["parts", index, "position", "y"],
          message: "Part exceeds the normalized height",
        });
      if (Math.abs(part.position.z) + halfZ > 0.9)
        ctx.addIssue({
          code: "custom",
          path: ["parts", index, "position", "z"],
          message: "Part exceeds the normalized depth",
        });
    }
  });

export type ParametricPart = z.infer<typeof parametricPartSchema>;
export type ParametricModel = z.infer<typeof parametricModelSchema>;
