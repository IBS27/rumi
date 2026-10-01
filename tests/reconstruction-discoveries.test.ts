import { describe, expect, it } from "bun:test";
import { exportPackage, readPackage } from "../shared/capture/package";
import { savedRoomSchema } from "../shared/capture/roomplan";
import type { CapturedRoom, RoomObject } from "../shared/contracts";
import { applyDesignCommands, type DesignCommand } from "../shared/design";
import { sampleBrief } from "../shared/fixtures";
import {
  discoveredRoomObject,
  discoveryUnedited,
  mergeDiscoveredObjects,
  planDiscoveredObjects,
  validateSceneForRoom,
  withoutProvenance,
  type DiscoveredObject,
} from "../shared/reconstruction/contracts";
import {
  activeSession,
  createSession,
  readSessions,
  updateActive,
  writeSessions,
  type Workspace,
} from "../src/features/workspace/sessions";
import { syntheticCaptureZip } from "./fixtures/capture-package";

const zipBytes = syntheticCaptureZip();
const base = readPackage(zipBytes).saved;
if (base.room.shape !== "polygon") throw new Error("Missing room");
const room: CapturedRoom = base.room;
const initial: Workspace = { ...base, room };

const lamp: DiscoveredObject = {
  objectId: "photo-lamp-left",
  name: "Floor lamp",
  category: "lighting",
  dimensions: { width: 0.25, height: 0.5, depth: 0.25 },
  // A clear floor spot, so moves pass placement validation.
  position: { x: 1, y: 0, z: 3 },
  rotation: { x: 0, y: 0, z: 0 },
  color: "#eee4cc",
  confidence: 0.8,
  evidence: "Visible shade and base beside the window in photo 0.",
  photoIndices: [0],
};
const discovery = (objectId: string): DiscoveredObject => ({
  ...lamp,
  objectId,
});
const model = (objectId: string) => ({
  objectId,
  label: "Item",
  confidence: 0.8,
  parts: [
    {
      id: "body",
      name: "Body",
      shape: "box" as const,
      size: { x: 1, y: 1, z: 1 },
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#eee4cc",
      material: "matte" as const,
    },
  ],
});
function scene(...discoveries: DiscoveredObject[]) {
  return validateSceneForRoom(
    {
      version: 1,
      model: "gpt-6-astra",
      roomId: room.id,
      surfaces: [],
      objects: [
        ...room.objects.map((object) => model(object.id)),
        ...discoveries.map((object) => model(object.objectId)),
      ],
      discoveredObjects: discoveries,
      notes: [],
    },
    room,
  );
}
function accept(
  workspace: Workspace,
  ...args: [ReturnType<typeof scene>, number | undefined]
): Workspace & { removedObjectIds: string[]; stale: boolean } {
  const merged = mergeDiscoveredObjects(
    workspace.room,
    args[0],
    workspace.reconstructionObjectIds,
    args[1],
  );
  return { ...workspace, ...merged };
}
function edit(workspace: Workspace, commands: DesignCommand[]): Workspace {
  const next = applyDesignCommands(workspace.room, commands, [], sampleBrief);
  if (next.shape !== "polygon") throw new Error("Expected captured room");
  return { ...workspace, room: next };
}
// The ZIP download and import path, including validation on both sides.
function throughZip(workspace: Workspace): Workspace {
  const saved = readPackage(
    exportPackage(zipBytes, savedRoomSchema.parse(workspace)),
  ).saved;
  if (saved.room.shape !== "polygon") throw new Error("Missing room");
  return { ...saved, room: saved.room };
}
// Browser persistence through the session store.
function throughBrowser(workspace: Workspace): Workspace {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const session = createSession();
  writeSessions(
    storage,
    "owner",
    updateActive(
      { version: 1, activeId: session.id, sessions: [session] },
      workspace,
    ),
  );
  const restored = activeSession(readSessions(storage, "owner")).workspace;
  if (!restored) throw new Error("Workspace was not restored");
  return restored;
}
const record = (workspace: Workspace) => workspace.room.reconstruction;
const ids = (workspace: Workspace) =>
  workspace.room.objects.map((object) => object.id);
const object = (workspace: Workspace, id: string) =>
  workspace.room.objects.find((item) => item.id === id)!;

describe("photo discovery cleanup", () => {
  it("replaces an obsolete discovery after regeneration and ignores obsolete cached scenes", () => {
    const first = throughZip(accept(initial, scene(lamp), 100));
    expect(object(first, lamp.objectId).discovery).toMatchObject({
      generation: 100,
    });
    expect(discoveryUnedited(object(first, lamp.objectId))).toBe(true);

    const replacement = discovery("photo-bedside-table-lamp");
    const second = accept(first, scene(replacement), 200);
    expect(second.removedObjectIds).toEqual([lamp.objectId]);
    expect(ids(second)).toEqual([
      ...room.objects.map((item) => item.id),
      replacement.objectId,
    ]);
    expect(record(second)).toEqual({
      generation: 200,
      applied: [lamp.objectId, replacement.objectId],
      retired: [{ id: lamp.objectId, generation: 200 }],
      deleted: [],
    });

    // Reloads deliver the same scene again; older cached scenes change nothing.
    const reloaded = throughBrowser(throughZip(second));
    expect(accept(reloaded, scene(replacement), 200).room).toBe(reloaded.room);
    const obsolete = accept(reloaded, scene(lamp), 100);
    expect(obsolete.stale).toBe(true);
    expect(obsolete.room).toBe(reloaded.room);
  });

  it("keeps discoveries changed by real design commands while measurements stay estimated", () => {
    const first = accept(initial, scene(lamp), 100);
    const original = object(first, lamp.objectId);
    const corrections: Partial<RoomObject>[] = [
      { name: "My bedside reading lamp" },
      { color: "#123456" },
      { category: "storage" },
      { dimensions: { ...original.dimensions, height: 0.55 } },
      { position: { ...original.position, x: 1.1 } },
      { rotation: { ...original.rotation, y: 0.3 } },
    ];
    const edits: DesignCommand[][] = [
      ...corrections.map((change) => [
        { type: "correct" as const, object: { ...original, ...change } },
      ]),
      [
        {
          type: "move",
          objectId: lamp.objectId,
          position: { ...original.position, z: 3.1 },
          rotationY: 0,
        },
      ],
      [
        {
          type: "move",
          objectId: lamp.objectId,
          position: original.position,
          rotationY: 0.4,
        },
      ],
    ];
    for (const commands of edits) {
      const edited = throughBrowser(throughZip(edit(first, commands)));
      const changed = object(edited, lamp.objectId);
      expect(changed.measurementSource).toBe("estimated");
      expect(changed.discovery).toEqual(original.discovery);
      const result = accept(edited, scene(), 200);
      expect(result.removedObjectIds).toEqual([]);
      expect(object(result, lamp.objectId)).toEqual(changed);
    }

    // Resetting to the discovered values makes the object replaceable again.
    const reset = edit(
      edit(first, [
        { type: "correct", object: { ...original, name: "Renamed" } },
      ]),
      [{ type: "correct", object: { ...original, discovery: undefined } }],
    );
    expect(accept(reset, scene(), 200).removedObjectIds).toEqual([
      lamp.objectId,
    ]);
  });

  it("does not let a correction rewrite discovery provenance", () => {
    const first = accept(initial, scene(lamp), 100);
    const original = object(first, lamp.objectId);
    const renamed = { ...original, name: "Mine" };
    const forged = edit(first, [
      {
        type: "correct",
        object: {
          ...renamed,
          discovery: { generation: 100, baseline: withoutProvenance(renamed) },
        },
      },
    ]);
    expect(object(forged, lamp.objectId).discovery).toEqual(original.discovery);
    expect(accept(forged, scene(), 200).removedObjectIds).toEqual([]);
  });

  it("keeps protected, native, legacy, newer and untracked objects", () => {
    const first = accept(initial, scene(lamp), 100);
    const discovered = object(first, lamp.objectId);
    const provenance = discovered.discovery!;
    const legacy = withoutProvenance(discovered);
    const protectedObjects: RoomObject[] = [
      { ...discovered, id: "photo-locked", locked: true },
      { ...discovered, id: "photo-product-locked", productLocked: true },
      {
        ...discovered,
        id: "photo-confirmed",
        measurementSource: "confirmed",
      },
      { ...discovered, id: "photo-product", productId: "chosen-product" },
      { ...discovered, id: "photo-asset", assetId: "custom-model" },
      { ...discovered, id: "photo-unowned", owned: false },
      { ...discovered, id: "photo-support" },
      {
        ...discovered,
        id: "photo-supported",
        supportId: "photo-support",
        locked: true,
      },
      { ...legacy, id: "photo-legacy" },
      { ...discovered, id: "native", detectionSource: undefined },
      {
        ...discovered,
        id: "photo-newer",
        discovery: { ...provenance, generation: 300 },
      },
    ];
    // Baselines match each object so only the guard under test protects it.
    const withBaseline = protectedObjects.map((item) =>
      item.discovery && item.id !== "photo-newer"
        ? {
            ...item,
            discovery: {
              generation: 100,
              baseline: withoutProvenance(item),
            },
          }
        : item,
    );
    const crowded: Workspace = {
      ...first,
      room: {
        ...first.room,
        objects: [
          ...first.room.objects,
          ...withBaseline,
          { ...discovered, id: "photo-untracked" },
        ],
      },
      reconstructionObjectIds: protectedObjects.map((item) => item.id),
    };
    const result = accept(crowded, scene(), 200);
    expect(result.removedObjectIds).toEqual([lamp.objectId]);
    expect(ids(result)).toEqual(
      ids(crowded).filter((id) => id !== lamp.objectId),
    );

    // A foreign room is rejected before any cleanup.
    expect(() =>
      planDiscoveredObjects(
        { ...crowded.room, id: "another-room" },
        scene(),
        crowded.reconstructionObjectIds,
        200,
      ),
    ).toThrow("another room");
  });

  it("preserves legacy saves that lack provenance", () => {
    // Saved by the append-only merge: both generations, no bookkeeping.
    const legacyObject = {
      ...object(accept(initial, scene(lamp), undefined), lamp.objectId),
    };
    expect(legacyObject.discovery).toBeUndefined();
    const legacy = throughZip({
      ...initial,
      room: { ...room, objects: [...room.objects, legacyObject] },
      reconstructionObjectIds: [lamp.objectId, "photo-removed-earlier"],
    });
    const result = accept(legacy, scene(discovery("photo-new")), 200);
    expect(result.removedObjectIds).toEqual([]);
    expect(ids(result)).toEqual([...ids(legacy), "photo-new"]);
    // An applied ID without a retirement record was removed by the user.
    expect(
      accept(
        result,
        scene(discovery("photo-new"), discovery("photo-removed-earlier")),
        300,
      ).room.objects,
    ).toEqual(result.room.objects);
  });

  it("restores an automatically retired discovery in a newer generation but never a user deletion", () => {
    const vase = discovery("photo-vase");
    // A supplies both; the user removes the vase.
    const a = accept(initial, scene(lamp, vase), 100);
    const removed = throughBrowser(
      edit(a, [{ type: "remove", objectId: vase.objectId }]),
    );
    // B omits both: the untouched lamp is retired, the vase becomes a tombstone.
    const b = throughZip(accept(removed, scene(), 200));
    expect(record(b)).toEqual({
      generation: 200,
      applied: [lamp.objectId, vase.objectId],
      retired: [{ id: lamp.objectId, generation: 200 }],
      deleted: [vase.objectId],
    });
    // A cached A or B cannot restore anything.
    expect(accept(b, scene(lamp, vase), 100).room).toBe(b.room);
    expect(accept(b, scene(lamp, vase), 200).room).toBe(b.room);
    // C models both again: the lamp returns, the vase stays removed.
    const c = throughBrowser(throughZip(accept(b, scene(lamp, vase), 300)));
    expect(ids(c)).toEqual([
      ...room.objects.map((item) => item.id),
      lamp.objectId,
    ]);
    expect(object(c, lamp.objectId).discovery?.generation).toBe(300);
    expect(record(c)).toEqual({
      generation: 300,
      applied: [lamp.objectId, vase.objectId],
      retired: [],
      deleted: [vase.objectId],
    });
    // Once restored, B arriving late is obsolete and does not retire it again.
    expect(accept(c, scene(), 200).room).toBe(c.room);
    // If the user removes the restored lamp, no later generation brings it back.
    const gone = edit(c, [{ type: "remove", objectId: lamp.objectId }]);
    const d = accept(gone, scene(lamp, vase), 400);
    expect(ids(d)).toEqual(room.objects.map((item) => item.id));
    expect(record(d)?.deleted.sort()).toEqual(
      [lamp.objectId, vase.objectId].sort(),
    );
  });

  it("keeps objects an account undo restores", () => {
    const vase = discovery("photo-vase");
    const a = accept(initial, scene(lamp, vase), 100);
    // Account undo restores objects but keeps the bookkeeping.
    const removed = edit(a, [{ type: "remove", objectId: vase.objectId }]);
    expect(record(removed)?.deleted).toEqual([vase.objectId]);
    const undone = {
      ...removed,
      room: { ...removed.room, objects: a.room.objects },
    };
    expect(accept(undone, scene(lamp, vase), 100).room).toBe(undone.room);
    // An undone automatic retirement is not retired again.
    const retired = accept(a, scene(vase), 200);
    expect(retired.removedObjectIds).toEqual([lamp.objectId]);
    const restored = {
      ...retired,
      room: { ...retired.room, objects: a.room.objects },
    };
    expect(accept(restored, scene(vase), 300).removedObjectIds).toEqual([]);
  });

  it("validates reconstruction commands where they commit", () => {
    const first = accept(initial, scene(lamp), 200);
    const renamed = edit(first, [
      {
        type: "correct",
        object: { ...object(first, lamp.objectId), name: "Mine" },
      },
    ]);
    expect(() =>
      edit(renamed, [
        { type: "retire", objectId: lamp.objectId, generation: 300 },
      ]),
    ).toThrow("edited or kept");
    expect(() =>
      edit(first, [
        { type: "retire", objectId: lamp.objectId, generation: 200 },
      ]),
    ).toThrow("edited or kept");
    expect(() =>
      edit(first, [{ type: "generation", generation: 100 }]),
    ).toThrow("newer reconstruction");
    expect(() =>
      applyDesignCommands(
        first.room,
        [{ type: "retire", objectId: lamp.objectId, generation: 300 }],
        [],
        sampleBrief,
        "agent",
      ),
    ).toThrow();
    const gone = edit(first, [{ type: "remove", objectId: lamp.objectId }]);
    expect(() =>
      edit(gone, [
        { type: "discover", object: discoveredRoomObject(lamp, 300) },
      ]),
    ).toThrow("will not be added again");
  });

  it("commits bookkeeping with each batch, so an interrupted save resumes from the room", () => {
    const old = discovery("photo-old");
    const first = accept(initial, scene(old), 100);
    const fresh = Array.from({ length: 48 }, (_, index) =>
      discovery(`photo-new-${index}`),
    );
    const next = scene(...fresh);
    // Only the authoritative room survives between batches.
    let current = first.room;
    const batches: number[] = [];
    for (;;) {
      const { commands } = planDiscoveredObjects(current, next, [], 200);
      if (!commands.length) break;
      batches.push(Math.min(commands.length, 40));
      current = edit({ ...first, room: current }, commands.slice(0, 40)).room;
      if (batches.length === 1)
        expect(current.reconstruction).toMatchObject({
          generation: 200,
          applied: [
            old.objectId,
            ...fresh.slice(0, 39).map((item) => item.objectId),
          ],
          retired: [{ id: old.objectId, generation: 200 }],
          deleted: [],
        });
    }
    expect(batches).toEqual([40, 9]);
    const whole = accept(first, next, 200);
    // JSON drops negative zero from native scan rotations, as storage does.
    expect(JSON.parse(JSON.stringify(whole.room.objects))).toEqual(
      JSON.parse(JSON.stringify(current.objects)),
    );
    expect(whole.room.reconstruction).toEqual(current.reconstruction);
    // A later generation that omits them retires all 48.
    expect(
      mergeDiscoveredObjects(current, scene(), [], 300).removedObjectIds,
    ).toHaveLength(48);
  });
});
