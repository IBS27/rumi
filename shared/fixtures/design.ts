import { assetSchema, type AssetRecord } from "../contracts";
import { sampleProducts } from ".";
import type { ParametricModel } from "../assets/model";

/** Hand-authored, explicitly synthetic previews for the offline sample catalog. */
export const sampleDesignAssets: AssetRecord[] = sampleProducts.map(
  (product) => {
    const part = (
      id: string,
      size: [number, number, number],
      position: [number, number, number],
      shape: "box" | "cylinder" = "box",
    ): ParametricModel["parts"][number] => ({
      id,
      name: id,
      shape,
      size: { x: size[0], y: size[1], z: size[2] },
      position: { x: position[0], y: position[1], z: position[2] },
      rotation: { x: 0, y: 0, z: 0 },
      color: product.color,
      material:
        product.category === "rug"
          ? "fabric"
          : product.category === "lighting"
            ? "metal"
            : "wood",
    });
    const parts =
      product.category === "lighting"
        ? [
            part("base", [0.75, 0.04, 0.75], [0, 0.02, 0], "cylinder"),
            part("stem", [0.04, 0.8, 0.04], [0, 0.44, 0], "cylinder"),
            part("shade", [0.65, 0.18, 0.65], [0, 0.91, 0], "cylinder"),
          ]
        : product.category === "storage"
          ? [
              part("cabinet", [1, 0.8, 1], [0, 0.6, 0]),
              ...[-0.4, 0.4].flatMap((x) =>
                [-0.4, 0.4].map((z) =>
                  part(`leg-${x}-${z}`, [0.06, 0.2, 0.06], [x, 0.1, z]),
                ),
              ),
            ]
          : [part(product.category, [1, 1, 1], [0, 0.5, 0])];
    return assetSchema.parse({
      id: product.assetId ?? `${product.id}-asset`,
      status: "ready",
      accuracy: "approximate",
      url: null,
      scale: 1,
      rotation: { x: 0, y: 0, z: 0 },
      scene: {
        version: 1,
        label: `${product.name} (synthetic sample)`,
        dimensions: product.measurement.dimensions,
        sourceImages: [product.imageUrl ?? product.sourceUrl],
        sourceViews: [
          { url: product.imageUrl ?? product.sourceUrl, role: "front" },
        ],
        parts,
        confidence: 0,
        notes: ["Hand-authored synthetic preview, not a real merchant model."],
      },
    });
  },
);
