import { ParametricModel } from "../src/features/room-editor/ParametricModel";
import { Group, Vector3 } from "three";
import { describe, expect, it, mock } from "bun:test";
import { MockLanguageModelV2 } from "ai/test";
import { savedRoomSchema } from "../shared/capture/roomplan";
import { readPackage, exportPackage } from "../shared/capture/package";
import {
  syntheticCaptureZip,
  identityMatrix,
} from "./fixtures/capture-package";
import {
  buildReconstructionEvidence,
  selectCaptureViews,
} from "../shared/reconstruction/evidence";
import {
  reconstructedSceneSchema,
  reconstructionInputSchema,
  validateSceneForRoom,
  mergeDiscoveredObjects,
  validateDiscoveredObjects,
  type DiscoveredObject,
  type ReconstructionInput,
} from "../shared/reconstruction/contracts";
import {
  generateRoomReconstruction,
  modelRoomReconstruction,
  planSchema,
  assembleRoomReconstruction,
} from "../convex/roomReconstructionGeneration";

export async function evidence() {
  return buildReconstructionEvidence(
    readPackage(syntheticCaptureZip()),
    async () => ({ jpeg: "/9j/2Q==", width: 32, height: 32 }),
  );
}
const part = {
  id: "top",
  name: "Top",
  shape: "box" as const,
  size: { x: 1, y: 0.1, z: 1 },
  position: { x: 0, y: 0.95, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  color: "#987654",
  material: "wood" as const,
};
export function sceneFor(input: ReconstructionInput) {
  return reconstructedSceneSchema.parse({
    version: 1,
    model: "gpt-6-astra",
    roomId: input.room.id,
    surfaces: [],
    objects: input.room.objects.map((o) => ({
      objectId: o.id,
      label: o.name,
      confidence: 0.8,
      parts: [part],
    })),
    notes: [],
  });
}
function model(...answers: unknown[]) {
  const prompts: unknown[] = [];
  return {
    prompts,
    instance: new MockLanguageModelV2({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            { type: "text", text: JSON.stringify(answers[prompts.length - 1]) },
          ],
          warnings: [],
        };
      },
    }),
  };
}
function plan(input: ReconstructionInput) {
  return {
    surfaces: [],
    discoveredObjects: [],
    notes: [],
    objects: input.room.objects.map((o) => ({
      objectId: o.id,
      description: "A wooden table with separated legs",
      photoIndices: [0],
    })),
  };
}

const lamp: DiscoveredObject = {
  objectId: "photo-lamp-left",
  name: "Bedside lamp",
  category: "lighting",
  dimensions: { width: 0.25, height: 0.5, depth: 0.25 },
  position: { x: 1, y: 0.8, z: 1 },
  rotation: { x: 0, y: 0, z: 0 },
  color: "#eee4cc",
  confidence: 0.8,
  evidence: "Visible shade and base on the bedside table in photo 0.",
  photoIndices: [0],
};

describe("room reconstruction", () => {
  it("resumes bounded model waves without repeating saved objects or photo analysis", async () => {
    const input = await evidence();
    const expected = sceneFor(input);
    const assessment = planSchema.parse(plan(input));
    const vision = model(
      ...Array.from(
        { length: Math.ceil(expected.objects.length / 3) },
        (_, i) => ({ objects: expected.objects.slice(i * 3, i * 3 + 3) }),
      ),
    );
    const signal = new AbortController().signal;
    const persisted: typeof expected.objects = [];
    const first = await modelRoomReconstruction(
      vision.instance,
      input,
      assessment,
      async () => {},
      signal,
      [],
      1,
      async (batch) => {
        persisted.push(...batch);
      },
    );
    expect(first).toEqual(expected.objects.slice(0, 3));
    expect(persisted).toEqual(first);
    expect(vision.prompts).toHaveLength(1);
    const rest = await modelRoomReconstruction(
      vision.instance,
      input,
      assessment,
      async () => {},
      signal,
      persisted,
      3,
    );
    expect(assembleRoomReconstruction(input, assessment, rest).objects).toEqual(
      expected.objects,
    );
    expect(vision.prompts).toHaveLength(Math.ceil(expected.objects.length / 3));
  });
  it("models photo discoveries alongside scans and reports the expanded inventory", async () => {
    const input = await evidence();
    const scene = sceneFor(input);
    const object = {
      ...scene.objects[0],
      objectId: lamp.objectId,
      label: lamp.name,
    };
    const expected = [...scene.objects, object];
    const answers: unknown[] = [
      {
        ...plan(input),
        discoveredObjects: [
          { ...lamp, description: "Round shade on a slender stem and base." },
        ],
      },
    ];
    for (let i = 0; i < expected.length; i += 3)
      answers.push({ objects: expected.slice(i, i + 3) });
    const vision = model(...answers);
    const updates: number[][] = [];
    const result = await generateRoomReconstruction(
      vision.instance,
      input,
      async (done, total) => {
        updates.push([done, total]);
      },
      new AbortController().signal,
    );
    expect(result.objects).toEqual(expected);
    expect(result.discoveredObjects).toEqual([lamp]);
    expect(updates.at(-1)).toEqual([expected.length, expected.length]);
  });
  it("keeps attached panels in their parent without changing measured dimensions", async () => {
    const input = await evidence();
    if (input.room.shape !== "polygon") throw new Error("Missing room");
    const room = input.room;
    const scene = sceneFor(input);
    const measured = structuredClone(input.room);
    const height = input.room.objects[0].dimensions.height;
    scene.objects[0].renderBounds = {
      scale: { x: 1, y: 1 + 0.5 / height, z: 1 },
      offset: { x: 0, y: 0, z: 0 },
    };
    scene.objects[0].parts[0].name = "Attached wooden panel";
    expect(validateSceneForRoom(scene, room).objects[0].renderBounds).toEqual(
      scene.objects[0].renderBounds,
    );
    expect(input.room).toEqual(measured);
    scene.objects[0].renderBounds.offset.y = 0.2;
    expect(() => validateSceneForRoom(scene, room)).toThrow("Visual bounds");
    scene.objects[0].renderBounds.offset.y = 0;
    scene.objects[0].renderBounds.scale.y = 1 + 2.1 / height;
    expect(() => validateSceneForRoom(scene, room)).toThrow();
  });
  it("renders attached bounds in the parent's local axes and scales them with edits", async () => {
    const scene = sceneFor(await evidence());
    for (const height of [0.5, 1]) {
      const element = ParametricModel({
        model: {
          ...scene.objects[0],
          dimensions: { width: 2, height, depth: 2 },
          renderBounds: {
            scale: { x: 1.2, y: 3, z: 1.1 },
            offset: { x: 0, y: 0, z: -0.05 },
          },
        },
      });
      const rendered = element.props as {
        scale: [number, number, number];
        children: {
          props: {
            scale: [number, number, number];
            position: [number, number, number];
          };
        };
      };
      const outer = new Group(),
        visual = new Group();
      outer.scale.fromArray(rendered.scale);
      visual.scale.fromArray(rendered.children.props.scale);
      visual.position.fromArray(rendered.children.props.position);
      outer.add(visual);
      outer.updateMatrixWorld(true);
      const headboardTop = visual.localToWorld(new Vector3(0, 1, 0));
      expect(headboardTop.y).toBeCloseTo(height * 3);
      expect(headboardTop.z).toBeCloseTo(-0.1);
      expect(visual.localToWorld(new Vector3(0, 1 / 3, 0)).y).toBeCloseTo(
        height,
      );
    }
  });
  it("rejects ungrounded IDs, missing discovery models, invalid photos and out-of-room placement", async () => {
    const input = await evidence();
    if (input.room.shape !== "polygon") throw new Error("Missing room");
    const room = input.room;
    expect(() => validateDiscoveredObjects([lamp, lamp], room)).toThrow(
      "unique",
    );
    expect(() =>
      validateDiscoveredObjects(
        [{ ...lamp, objectId: room.objects[0].id }],
        room,
      ),
    ).toThrow("unique");
    expect(() =>
      validateDiscoveredObjects([{ ...lamp, photoIndices: [1] }], room, 1),
    ).toThrow("photos");
    expect(() =>
      validateDiscoveredObjects(
        [{ ...lamp, position: { x: 100, y: 0, z: 0 } }],
        room,
      ),
    ).toThrow("bounds");
    expect(() =>
      validateSceneForRoom(
        { ...sceneFor(input), discoveredObjects: [lamp] },
        room,
      ),
    ).toThrow("does not match");
  });
  it("preserves edits and deletions across cached results, saved-room reload and ZIP export", async () => {
    const input = await evidence();
    if (input.room.shape !== "polygon") throw new Error("Missing room");
    const scene = sceneFor(input);
    scene.discoveredObjects = [lamp];
    scene.objects.push({ ...scene.objects[0], objectId: lamp.objectId });
    const first = mergeDiscoveredObjects(input.room, scene);
    expect(first.room.objects.at(-1)).toMatchObject({
      id: lamp.objectId,
      measurementSource: "estimated",
      detectionSource: "photo",
    });
    const edited = {
      ...first.room,
      objects: first.room.objects.map((o) =>
        o.id === lamp.objectId
          ? { ...o, name: "My lamp", position: { x: 2, y: 1, z: 2 } }
          : o,
      ),
    };
    expect(
      mergeDiscoveredObjects(edited, scene, first.reconstructionObjectIds).room,
    ).toEqual(edited);
    const removed = {
      ...edited,
      objects: edited.objects.filter((o) => o.id !== lamp.objectId),
    };
    const saved = savedRoomSchema.parse({
      ...readPackage(syntheticCaptureZip()).saved,
      ...first,
      room: removed,
    });
    const reloaded = readPackage(
      exportPackage(syntheticCaptureZip(), saved),
    ).saved;
    if (reloaded.room.shape !== "polygon") throw new Error("Missing room");
    expect(
      mergeDiscoveredObjects(
        reloaded.room,
        scene,
        reloaded.reconstructionObjectIds,
      ).room.objects,
    ).toEqual(JSON.parse(JSON.stringify(removed.objects)));
    expect(
      mergeDiscoveredObjects(first.room, scene, first.reconstructionObjectIds)
        .room.objects,
    ).toHaveLength(input.room.objects.length + 1);
  });

  it("retains measured geometry, scales calibration and carries synthetic provenance", async () => {
    const input = await evidence();
    expect(input.room.shape).toBe("polygon");
    if (input.room.shape !== "polygon")
      throw new Error("Missing captured room");
    expect(input.room.capture.synthetic).toBe(true);
    expect(input.mesh.samples[0].vertices).toEqual([1, 0, 2, 3, 0, 2, 2, 2, 2]);
    expect(input.photos[0].fx).toBe(16);
    expect(input.photos[0].cx).toBe(16);
    expect(input.photos[0].cameraTransform.slice(12, 15)).toEqual([2, 1, 4]);
  });
  it("subtracts the original room origin from both cameras and measured mesh", async () => {
    const capture = readPackage(syntheticCaptureZip());
    const original = capture.saved.original as {
      walls: Array<{ transform: number[] }>;
      floors: Array<{ transform: number[] }>;
      objects: Array<{ transform: number[] }>;
      doors: Array<{ transform: number[] }>;
      windows: Array<{ transform: number[] }>;
    };
    for (const item of [
      ...original.walls,
      ...original.floors,
      ...original.objects,
      ...original.doors,
      ...original.windows,
    ])
      item.transform[12] += 10;
    capture.manifest.meshes[0].transform[12] += 10;
    capture.manifest.frames[0].cameraTransform[12] += 10;
    const result = await buildReconstructionEvidence(capture, async () => ({
      jpeg: "/9j/2Q==",
      width: 64,
      height: 64,
    }));
    expect(result.photos[0].cameraTransform[12]).toBe(2);
    expect(result.mesh.samples[0].vertices[0]).toBe(1);
  });
  it("chooses different camera directions rather than adjacent duplicate frames", () => {
    const frame = readPackage(syntheticCaptureZip()).manifest.frames[0];
    const frames = Array.from({ length: 30 }, (_, index) => ({
      ...frame,
      timestamp: index,
      cameraTransform: [...identityMatrix],
    }));
    frames[29].cameraTransform[0] = -1;
    frames[29].cameraTransform[10] = -1;
    expect(selectCaptureViews(frames, 2).map((f) => f.timestamp)).toEqual([
      0, 29,
    ]);
  });
  it("rejects missing photos and remote URL image payloads", async () => {
    const input = await evidence();
    expect(
      reconstructionInputSchema.safeParse({ ...input, photos: [] }).success,
    ).toBe(false);
    expect(
      reconstructionInputSchema.safeParse({
        ...input,
        photos: [{ ...input.photos[0], jpeg: "https://host.invalid/private" }],
      }).success,
    ).toBe(false);
  });
  it("rejects changed IDs, missing objects, duplicate IDs and rotated overflow", async () => {
    const input = await evidence();
    if (input.room.shape !== "polygon")
      throw new Error("Missing captured room");
    const room = input.room;
    const scene = sceneFor(input);
    expect(validateSceneForRoom(scene, input.room).objects.length).toBe(
      input.room.objects.length,
    );
    expect(() =>
      validateSceneForRoom({ ...scene, roomId: "other" }, room),
    ).toThrow();
    expect(() =>
      validateSceneForRoom({ ...scene, objects: scene.objects.slice(1) }, room),
    ).toThrow();
    expect(() =>
      validateSceneForRoom(
        {
          ...scene,
          objects: [scene.objects[0], ...scene.objects.slice(0, -1)],
        },
        room,
      ),
    ).toThrow();
    const overflow = structuredClone(scene);
    overflow.objects[0].parts[0].rotation.y = Math.PI / 4;
    expect(reconstructedSceneSchema.safeParse(overflow).success).toBe(false);
  });
  it("sends photos, calibration and geometry to Astra, models all objects, and reports progress", async () => {
    const input = await evidence(),
      scene = sceneFor(input);
    input.room.objects.forEach((object) => {
      object.color = "#ff00ff";
    });
    const answers: unknown[] = [plan(input)];
    for (let i = 0; i < scene.objects.length; i += 3)
      answers.push({ objects: scene.objects.slice(i, i + 3) });
    const vision = model(...answers),
      updates: number[] = [];
    const result = await generateRoomReconstruction(
      vision.instance,
      input,
      async (n) => {
        updates.push(n);
      },
      new AbortController().signal,
    );
    expect(result.objects).toEqual(scene.objects);
    expect(updates[0]).toBe(0);
    expect(updates.at(-1)).toBe(input.room.objects.length);
    expect(JSON.stringify(vision.prompts[0])).toContain("cameraTransform");
    expect(JSON.stringify(vision.prompts[0])).toContain(
      "Sampled LiDAR triangles",
    );
    expect(JSON.stringify(vision.prompts[0])).toContain('"type":"file"');
    // Importer category colors must not influence the photo-derived palette.
    expect(JSON.stringify(vision.prompts)).not.toContain("#ff00ff");
  });
  it("does not model a plan that invents or omits furniture", async () => {
    const input = await evidence();
    const vision = model({ ...plan(input), objects: [] });
    await expect(
      generateRoomReconstruction(
        vision.instance,
        input,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not match");
    expect(vision.prompts).toHaveLength(1);
  });
  it("repairs invalid finish scale once while retaining the observed finish", async () => {
    const input = await evidence();
    if (input.room.shape !== "polygon") throw new Error("Missing capture");
    const scene = sceneFor(input);
    const assessment = {
      ...plan(input),
      surfaces: [
        {
          surfaceId: input.room.walls[0].id,
          color: "#987654",
          material: "wood" as const,
          detail: {
            texture: "woodgrain" as const,
            repeatWidth: 0.24,
            repeatHeight: 1.2,
            roughness: 0.55,
          },
          regions: null,
        },
      ],
    };
    const invalid = structuredClone(assessment);
    invalid.surfaces[0].detail.repeatWidth = 0;
    const answers: unknown[] = [invalid, assessment];
    for (let i = 0; i < scene.objects.length; i += 3)
      answers.push({ objects: scene.objects.slice(i, i + 3) });
    const vision = model(...answers);
    const result = await generateRoomReconstruction(
      vision.instance,
      input,
      async () => {},
      new AbortController().signal,
    );
    expect(result.surfaces).toEqual(assessment.surfaces);
    expect(JSON.stringify(vision.prompts[1])).toContain(
      "Correct the following scene assessment",
    );
    expect(result.objects).toEqual(scene.objects);
  });
  it("passes embedded photos without fetching data URLs in the Convex runtime", async () => {
    const input = await evidence(),
      scene = sceneFor(input);
    const answers: unknown[] = [plan(input)];
    for (let i = 0; i < scene.objects.length; i += 3)
      answers.push({ objects: scene.objects.slice(i, i + 3) });
    const vision = model(...answers);
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
    const fetchMock = mock(async () => {
      throw new Error("Unsupported URL scheme: data");
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    try {
      const result = await generateRoomReconstruction(
        vision.instance,
        input,
        async () => {},
        new AbortController().signal,
      );
      expect(result.objects).toEqual(scene.objects);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "fetch", originalFetch);
    }
  });
  it("corrects invalid generated geometry once, then fails without publishing a partial scene", async () => {
    const input = await evidence();
    // Isolate correction of one batch; other batches are now concurrent.
    input.room.objects = input.room.objects.slice(0, 3);
    const scene = sceneFor(input);
    const bad = structuredClone(scene.objects.slice(0, 3));
    bad[0].parts[0].size.x = 1.5;
    const vision = model(plan(input), { objects: bad }, { objects: bad });
    await expect(
      generateRoomReconstruction(
        vision.instance,
        input,
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(vision.prompts).toHaveLength(3);
  });
});
