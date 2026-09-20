import { describe, expect, it } from "bun:test";
import { MockLanguageModelV2 } from "ai/test";
import { generateParametricModel } from "../convex/assetGeneration";
import { parametricModelSchema } from "../shared/assets/model";
import { assetSchema } from "../shared/contracts";

function model(...answers: unknown[]) {
  const prompts: unknown[] = [];
  return {
    instance: new MockLanguageModelV2({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        const answer = answers[prompts.length - 1];
        return {
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text" as const, text: JSON.stringify(answer) }],
          warnings: [],
        };
      },
    }),
    prompts,
  };
}

const oneImageSelection = {
  dimensionImageIndex: null,
  selected: [{ index: 0, role: "front" }],
};

const answer = {
  label: "Oak cabinet",
  confidence: 0.82,
  notes: ["Rear surface is not visible."],
  parts: [
    {
      id: "body",
      name: "Cabinet body",
      shape: "box",
      size: { x: 1, y: 1, z: 1 },
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#9a7049",
      material: "wood",
    },
  ],
};

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const imageFetch = (async () =>
  new Response(png, {
    status: 200,
    headers: { "content-type": "image/png" },
  })) as unknown as typeof fetch;

describe("image-to-3D assets", () => {
  it("keeps verified dimensions outside the model's control", async () => {
    const vision = model(oneImageSelection, answer);
    const scene = await generateParametricModel(
      vision.instance,
      {
        name: "Oak cabinet",
        category: "storage",
        dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
        imageUrls: ["https://shop.test/front.png"],
      },
      imageFetch,
    );
    expect(scene.dimensions).toEqual({ width: 1.1, height: 0.7, depth: 0.35 });
    expect(scene.sourceImages).toEqual(["https://shop.test/front.png"]);
    expect(scene.sourceViews).toEqual([
      { url: "https://shop.test/front.png", role: "front" },
    ]);
    expect(scene.parts[0].shape).toBe("box");
    expect(vision.prompts).toHaveLength(2);
  });

  it("includes the dimension drawing and sends four distinct views to reconstruction", async () => {
    const selection = {
      dimensionImageIndex: 4,
      selected: [
        { index: 4, role: "dimensions" },
        { index: 0, role: "front" },
        { index: 1, role: "side" },
        { index: 2, role: "three-quarter" },
      ],
    };
    const vision = model(selection, answer);
    const imageUrls = ["front", "side", "angle", "detail", "dimensions"].map(
      (name) => `https://shop.test/${name}.png`,
    );
    const scene = await generateParametricModel(
      vision.instance,
      {
        name: "Oak cabinet",
        category: "storage",
        dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
        imageUrls,
      },
      imageFetch,
    );
    expect(scene.sourceViews.map((view) => view.role)).toEqual([
      "dimensions",
      "front",
      "side",
      "three-quarter",
    ]);
    expect(scene.sourceImages[0]).toContain("dimensions.png");
    const reconstructionContent = (
      vision.prompts[1] as { content: { type: string }[] }[]
    )[0].content;
    expect(
      reconstructionContent.filter((part) => part.type === "file"),
    ).toHaveLength(4);
  });

  it("accepts a ready asset backed by a parametric scene", () => {
    const scene = parametricModelSchema.parse({
      version: 1,
      dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
      sourceImages: ["https://shop.test/front.png"],
      sourceViews: [{ url: "https://shop.test/front.png", role: "front" }],
      ...answer,
    });
    expect(
      assetSchema.safeParse({
        id: "oak-cabinet-asset",
        status: "ready",
        url: null,
        scene,
        accuracy: "approximate",
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
      }).success,
    ).toBe(true);
  });

  it("defaults an omitted part rotation to the identity transform", () => {
    const partWithoutRotation = { ...answer.parts[0] };
    delete (partWithoutRotation as Partial<typeof partWithoutRotation>)
      .rotation;
    const scene = parametricModelSchema.parse({
      version: 1,
      dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
      sourceImages: ["https://shop.test/front.png"],
      sourceViews: [{ url: "https://shop.test/front.png", role: "front" }],
      ...answer,
      parts: [partWithoutRotation],
    });
    expect(scene.parts[0].rotation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("rejects parts that extend far outside the product bounds", () => {
    expect(
      parametricModelSchema.safeParse({
        version: 1,
        dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
        sourceImages: ["https://shop.test/front.png"],
        sourceViews: [{ url: "https://shop.test/front.png", role: "front" }],
        ...answer,
        parts: [{ ...answer.parts[0], position: { x: 0.7, y: 0.5, z: 0 } }],
      }).success,
    ).toBe(false);
  });

  it("does not call Astra when no image can be downloaded", async () => {
    const vision = model(oneImageSelection, answer);
    await expect(
      generateParametricModel(
        vision.instance,
        {
          name: "Oak cabinet",
          category: "storage",
          dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
          imageUrls: ["https://shop.test/missing.png"],
        },
        (async () =>
          new Response("missing", { status: 404 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("No usable product images");
    expect(vision.prompts).toHaveLength(0);
  });

  it("rejects a selection that leaves out a detected dimension drawing", async () => {
    const vision = model({
      dimensionImageIndex: 4,
      selected: [
        { index: 0, role: "front" },
        { index: 1, role: "side" },
        { index: 2, role: "back" },
        { index: 3, role: "three-quarter" },
      ],
    });
    await expect(
      generateParametricModel(
        vision.instance,
        {
          name: "Oak cabinet",
          category: "storage",
          dimensions: { width: 1.1, height: 0.7, depth: 0.35 },
          imageUrls: ["front", "side", "back", "angle", "dimensions"].map(
            (name) => `https://shop.test/${name}.png`,
          ),
        },
        imageFetch,
      ),
    ).rejects.toThrow("dimension drawing was not included");
    expect(vision.prompts).toHaveLength(1);
  });
});
