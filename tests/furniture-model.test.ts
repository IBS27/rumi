import { expect, it } from "bun:test";
import { furnitureModel } from "../src/features/room-editor/furnitureModel";
import { applyDesignCommands } from "../shared/design";
import { sampleBrief, sampleProducts } from "../shared/fixtures";
import { sampleDesignAssets } from "../shared/fixtures/design";
import { importRoomPlan } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import type { ReconstructedObject } from "../shared/reconstruction/contracts";

it("discards captured geometry after replacement, including while the product model loads", () => {
  const room = importRoomPlan(syntheticRoomPlan, "Sample", true);
  const placed = applyDesignCommands(
    room,
    [{ type: "add", productId: sampleProducts[0].id, instanceId: "lamp" }],
    sampleProducts,
    sampleBrief,
  );
  const original = {
    ...placed.objects.find((o) => o.id === "lamp")!,
    owned: true,
    productId: null,
    assetId: null,
  };
  placed.objects = placed.objects.map((o) =>
    o.id === original.id ? original : o,
  );
  const scene = sampleDesignAssets[0].scene!;
  const reconstruction: ReconstructedObject = {
    objectId: original.id,
    label: "Original captured lamp",
    parts: scene.parts,
    confidence: 0.9,
    renderBounds: null,
  };
  expect(furnitureModel(original, reconstruction, undefined)?.label).toBe(
    reconstruction.label,
  );
  const replaced = applyDesignCommands(
    placed,
    [
      {
        type: "replace",
        objectId: original.id,
        productId: sampleProducts[0].id,
      },
    ],
    sampleProducts,
    sampleBrief,
  );
  const replacement = replaced.objects.find((o) => o.id === original.id)!;
  expect(
    furnitureModel(replacement, reconstruction, undefined),
  ).toBeUndefined();
  expect(furnitureModel(replacement, reconstruction, scene)).toBe(scene);
  // Undo restores the captured object's original model.
  expect(furnitureModel(original, reconstruction, scene)?.label).toBe(
    reconstruction.label,
  );
});
