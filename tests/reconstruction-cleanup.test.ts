import { describe, expect, it } from "bun:test";
import { clearEmbeddedDecor, clearFurnitureSurfaces } from "../shared/reconstruction/cleanup";
import type { ReconstructedObject } from "../shared/reconstruction/contracts";

const part = (id: string, name = id) => ({
  id, name, shape: "box" as const, material: "matte" as const,
  color: "#cccccc", size: { x: 0.1, y: 0.1, z: 0.1 },
  position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
});
const object = (label: string, ids: string[]): ReconstructedObject => ({
  objectId: "furniture", label, confidence: 0.9,
  renderBounds: { scale: { x: 1, y: 1.16, z: 1 }, offset: { x: 0, y: 0, z: 0 } },
  parts: ids.map((id) => part(id)),
});

describe("embedded reconstruction clutter", () => {
  it("removes phone parts while keeping the tabletop geometry and visual bounds unchanged", () => {
    const before = object("Espresso bedside table with telephone", ["table-top", "table-leg", "telephone-base", "telephone-handset", "telephone-keys"]);
    const after = clearFurnitureSurfaces(before);
    expect(after.label).toBe("Espresso bedside table");
    expect(after.parts).toEqual(before.parts.slice(0, 2));
    expect(after.renderBounds).toEqual(before.renderBounds);
    expect(before.parts).toHaveLength(5);
    expect(clearFurnitureSurfaces(after)).toEqual(after);
  });

  it("preserves TVs, computers and fixed hardware while removing loose vanity props", () => {
    const preserved = ["counter-top", "tv-screen", "monitor", "computer-tower", "laptop", "keyboard", "speaker", "lamp", "faucet", "drain", "towel-rail", "rail-bracket"];
    const before = object("Vanity cabinet", [...preserved, "tissue-box", "tissue", "hairdryer-handle", "counter-soap-dish", "hanging-towel"]);
    expect(clearFurnitureSurfaces(before).parts.map((p) => p.id)).toEqual(preserved);
  });

  it("leaves independently modeled objects and bedding alone", () => {
    for (const name of ["Telephone", "Tissue box", "Computer", "TV", "Potted plants", "Bed with pillows"])
      expect(clearFurnitureSurfaces(object(name, ["body", "tissue", "telephone-base", "pillow"]))).toEqual(object(name, ["body", "tissue", "telephone-base", "pillow"]));
    const scene = { version: 1 as const, roomId: "room", model: "gpt-6-astra" as const, surfaces: [], objects: [object("Desk", ["top", "telephone-base"])], notes: [] };
    expect(clearEmbeddedDecor(scene).objects[0].parts).toHaveLength(1);
    expect(scene.objects[0].parts).toHaveLength(2);
  });
});
