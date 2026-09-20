import { z } from "zod";

export const materialDetailSchema = z
  .object({
    texture: z.enum([
      "plain",
      "woodgrain",
      "weave",
      "carpet",
      "tile",
      "stone",
      "plaster",
    ]),
    // Size of one procedural repeat in meters, not pixels or normalized object units.
    repeatWidth: z.number().min(0).max(3),
    repeatHeight: z.number().min(0).max(3),
    roughness: z.number().min(0.05).max(1),
  })
  .superRefine((detail, ctx) => {
    // Plain materials never sample a texture; zero repeats correctly mean unused.
    if (detail.texture === "plain") return;
    for (const key of ["repeatWidth", "repeatHeight"] as const)
      if (detail[key] < 0.005)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            "Textured materials need a repeat size of at least 0.005 meters.",
        });
  });
export type MaterialDetail = z.infer<typeof materialDetailSchema>;
