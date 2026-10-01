import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RoomWorkspace } from "../src/features/room-editor/RoomWorkspace";
import type { ChatContext } from "../src/features/chat/ChatPanel";
import type { DesignConnection } from "../src/features/room-editor/designConnection";
import {
  activeSession,
  createSession,
  readSessions,
  updateActive,
  writeSessions,
  type Workspace,
} from "../src/features/workspace/sessions";
import { importRoomPlan, roomPlanSchema } from "../shared/capture/roomplan";
import type { CapturedRoom } from "../shared/contracts";
import { applyDesignCommands, type DesignCommand } from "../shared/design";
import { sampleBrief } from "../shared/fixtures";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import {
  discoveredRoomObject,
  validateSceneForRoom,
  type DiscoveredObject,
  type ReconstructedScene,
  type ReconstructionInput,
} from "../shared/reconstruction/contracts";

// Drives the real workspace with controlled cloud responses. Scan processing
// and browser storage are stubbed; the design rules and validation are real.
const dom = new Window({ url: "http://localhost" });
const original = roomPlanSchema.passthrough().parse(syntheticRoomPlan);
const scanned = importRoomPlan(syntheticRoomPlan, "Scanned room", false);
const room: CapturedRoom = {
  ...scanned,
  capture: { ...scanned.capture, synthetic: false },
};
const evidence: ReconstructionInput = {
  version: 1,
  room,
  mesh: { faceCount: 1, samples: [] },
  photos: [],
};
class ScanWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage() {
    setTimeout(() =>
      this.onmessage?.({
        data: {
          kind: "import",
          saved: { format: "rumi.room", version: 1, room, original },
          scan: {},
          evidence,
        },
      }),
    );
  }
  terminate() {}
}
// Answers the saved-scan lookup with a placeholder blob.
function later<T extends object>(result: T) {
  const request = {} as T & { result?: unknown; onsuccess?: () => void };
  setTimeout(() => {
    request.result = result;
    request.onsuccess?.();
  });
  return request;
}
const scanStore = {
  open: () =>
    later({
      transaction: () => ({
        objectStore: () => ({ get: () => later(new Blob(["zip"])) }),
      }),
      close() {},
    }),
};
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  screen: dom.screen,
  HTMLElement: dom.HTMLElement,
  ResizeObserver: dom.ResizeObserver,
  localStorage: dom.localStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
  Worker: ScanWorker,
  indexedDB: scanStore,
};
const previous = new Map(
  Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
let root: Root | undefined;
beforeEach(() => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  dom.document.body.innerHTML = "";
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
afterAll(() => dom.happyDOM.abort());

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
const lamp: DiscoveredObject = {
  objectId: "photo-old-lamp",
  name: "Lamp",
  category: "lighting",
  dimensions: { width: 0.25, height: 0.5, depth: 0.25 },
  position: { x: 1, y: 0, z: 1 },
  rotation: { x: 0, y: 0, z: 0 },
  color: "#eee4cc",
  confidence: 0.8,
  evidence: "Photo 0",
  photoIndices: [0],
};
const model = (objectId: string) => ({
  objectId,
  label: "Lamp",
  confidence: 0.8,
  parts: [
    {
      id: "body",
      name: "Body",
      shape: "box",
      size: { x: 1, y: 1, z: 1 },
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      color: "#eee4cc",
      material: "matte",
    },
  ],
});
const fresh = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ...lamp,
    objectId: `photo-new-${i}`,
  }));
function scene(discoveries: DiscoveredObject[]): ReconstructedScene {
  return validateSceneForRoom(
    {
      version: 1,
      model: "gpt-6-astra",
      roomId: room.id,
      surfaces: [],
      objects: [...room.objects, ...discoveries].map((object) =>
        model("id" in object ? object.id : object.objectId),
      ),
      discoveredObjects: discoveries,
      notes: [],
    },
    room,
  );
}

// Browser persistence through the session store, as a reload reads it.
function throughBrowser(workspace: Workspace): Workspace {
  const session = createSession();
  writeSessions(
    dom.localStorage,
    "reload",
    updateActive(
      { version: 1, activeId: session.id, sessions: [session] },
      workspace,
    ),
  );
  const restored = activeSession(
    readSessions(dom.localStorage, "reload"),
  ).workspace;
  if (!restored) throw new Error("Workspace was not restored");
  return restored;
}

/**
 * A workspace whose old lamp came from generation 100 of this scan, or a
 * reopened one. `server` is the account room the design connection reports.
 */
async function mount({
  cloud = true,
  workspace,
  server: account,
}: { cloud?: boolean; workspace?: Workspace; server?: CapturedRoom } = {}) {
  const saved: Workspace[] = [];
  const initial: Workspace = workspace ?? {
    format: "rumi.room",
    version: 1,
    room: {
      ...room,
      objects: [...room.objects, discoveredRoomObject(lamp, 100)],
      reconstruction: {
        generation: 100,
        applied: [lamp.objectId],
        retired: [],
        deleted: [],
      },
    },
    original,
    scanId: "c".repeat(32),
    ...(cloud ? { cloudProjectId: "p".repeat(32) } : {}),
  };
  let context: ChatContext | undefined;
  let ready:
    ((scene: ReconstructedScene, generation?: number) => void) | undefined;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () =>
    root!.render(
      <RoomWorkspace
        initial={initial}
        onPersist={(next) => {
          if (next) saved.push(next);
        }}
        chat={(props) => {
          context = props;
          return null;
        }}
        reconstruct={(_input, onReady) => {
          ready = onReady;
          return <span data-reconstructing />;
        }}
      />,
    ),
  );
  await flush();
  expect(ready).toBeDefined();
  let server = account ?? initial.room;
  const calls: DesignCommand[][] = [];
  const connect = (execute: DesignConnection["execute"]) =>
    act(async () =>
      context!.onDesign!({
        projectId: initial.cloudProjectId!,
        state: {
          room: server,
          products: [],
          assets: [],
          brief: sampleBrief,
          recommendations: [],
          canUndo: true,
        },
        execute,
        undo: async () => server,
        retryAsset: async () => null,
      }),
    );
  // The authoritative edit: the real design rules at the expected revision.
  const commit = (commands: DesignCommand[], revision: number) => {
    calls.push(commands);
    if (revision !== server.revision) throw new Error("The room changed.");
    const next = applyDesignCommands(server, commands, [], sampleBrief);
    if (next.shape !== "polygon") throw new Error("Expected capture");
    return (server = next);
  };
  return {
    saved,
    calls,
    connect,
    commit,
    server: () => server,
    deliver: (value: ReconstructedScene, generation: number) =>
      act(async () => ready!(value, generation)),
    latest: () => saved.at(-1) ?? initial,
    sceneShown: () => !dom.document.querySelector("[data-reconstructing]"),
  };
}
const ids = (value: CapturedRoom) => value.objects.map((object) => object.id);
const button = (label: string) =>
  [...dom.document.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );

it("resumes a reconstruction after its second batch fails, without duplicates", async () => {
  const app = await mount();
  let fail = true;
  await app.connect(async (commands, revision) => {
    if (app.calls.length === 1 && fail) {
      fail = false;
      app.calls.push(commands);
      throw new Error("Temporary network failure");
    }
    return app.commit(commands, revision);
  });
  const discoveries = fresh(48);
  await app.deliver(scene(discoveries), 200);
  await flush();
  expect(app.calls.map((batch) => batch.length)).toEqual([40, 9]);
  // The committed first batch is recorded; the scene stays pending with a retry.
  expect(app.server().objects.some((o) => o.id === lamp.objectId)).toBe(false);
  expect(app.latest().room.reconstruction).toMatchObject({
    generation: 200,
    retired: [{ id: lamp.objectId, generation: 200 }],
  });
  expect(app.latest().room.reconstruction?.applied).toHaveLength(40);
  expect(app.sceneShown()).toBe(false);
  expect(dom.document.body.textContent).toContain("Temporary network failure");

  await act(async () => button("Retry")!.click());
  await flush();
  expect(app.calls.map((batch) => batch.length)).toEqual([40, 9, 9]);
  const final = app.server();
  expect(new Set(ids(final)).size).toBe(final.objects.length);
  expect(ids(final)).toEqual([
    ...ids(room),
    ...discoveries.map((item) => item.objectId),
  ]);
  expect(app.latest().room).toEqual(final);
  expect(final.reconstruction).toEqual({
    generation: 200,
    applied: [lamp.objectId, ...discoveries.map((item) => item.objectId)],
    retired: [{ id: lamp.objectId, generation: 200 }],
    deleted: [],
  });
  expect(app.sceneShown()).toBe(true);
  expect(button("Retry")).toBeUndefined();
});

it("applies a scene after an edit in progress, keeping the user's removal", async () => {
  const app = await mount();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await app.connect(async (commands, revision) => {
    if (!app.calls.length) await pending;
    return app.commit(commands, revision);
  });
  // Remove the old lamp through the inspector.
  await act(async () => button("Show scan details")!.click());
  await act(async () =>
    [...dom.document.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("From photos"))!
      .click(),
  );
  await act(async () => button("Remove")!.click());
  // The newer scene still models the old lamp; it must not come back.
  await app.deliver(scene([lamp, ...fresh(1)]), 200);
  expect(dom.document.body.textContent).not.toContain(
    "Wait for the current edit to finish.",
  );
  await act(async () => finish());
  await flush();
  expect(app.calls).toEqual([
    [{ type: "remove", objectId: lamp.objectId }],
    [
      {
        type: "discover",
        object: discoveredRoomObject(fresh(1)[0], 200),
      },
    ],
  ]);
  expect(ids(app.server())).toEqual([...ids(room), "photo-new-0"]);
  expect(app.latest().room.reconstruction?.deleted).toEqual([lamp.objectId]);
  expect(app.sceneShown()).toBe(true);

  // A reload delivers the same scene again; nothing is written.
  const writes = app.saved.length;
  await app.deliver(scene([lamp, ...fresh(1)]), 200);
  await flush();
  expect(app.calls).toHaveLength(2);
  expect(app.saved).toHaveLength(writes);
});

it("waits for the cloud design before committing a cached scene", async () => {
  const app = await mount();
  await app.deliver(scene(fresh(1)), 200);
  await flush();
  expect(app.calls).toEqual([]);
  expect(app.saved).toEqual([]);
  expect(app.sceneShown()).toBe(false);
  await app.connect(async (commands, revision) =>
    app.commit(commands, revision),
  );
  await flush();
  expect(app.calls).toEqual([
    [
      { type: "retire", objectId: lamp.objectId, generation: 200 },
      { type: "discover", object: discoveredRoomObject(fresh(1)[0], 200) },
    ],
  ]);
  expect(ids(app.latest().room)).toEqual([...ids(room), "photo-new-0"]);
  expect(app.sceneShown()).toBe(true);
});

it("shows an obsolete generation without changing the room", async () => {
  const app = await mount({ cloud: false });
  await app.deliver(scene([]), 50);
  await flush();
  expect(app.saved).toEqual([]);
  expect(app.sceneShown()).toBe(true);
});

it("commits a local-only room without the cloud", async () => {
  const app = await mount({ cloud: false });
  await app.deliver(scene(fresh(2)), 200);
  await flush();
  expect(app.calls).toEqual([]);
  expect(ids(app.latest().room)).toEqual([
    ...ids(room),
    "photo-new-0",
    "photo-new-1",
  ]);
  expect(app.latest().room.reconstruction).toEqual({
    generation: 200,
    applied: [lamp.objectId, "photo-new-0", "photo-new-1"],
    retired: [{ id: lamp.objectId, generation: 200 }],
    deleted: [],
  });
});

it("does not write after the workspace is replaced mid-save", async () => {
  const app = await mount();
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await app.connect(async (commands, revision) => {
    await pending;
    return app.commit(commands, revision);
  });
  await app.deliver(scene(fresh(1)), 200);
  const writes = app.saved.length;
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => finish());
  await flush();
  // The account saved the edit; this browser session was not overwritten.
  expect(app.calls).toHaveLength(1);
  expect(app.saved).toHaveLength(writes);
});

it("resumes from the account room after a committed batch's response is lost", async () => {
  const app = await mount();
  let respond = () => {};
  const response = new Promise<void>((resolve) => {
    respond = resolve;
  });
  // The server commits the first batch, then the response is held.
  await app.connect(async (commands, revision) => {
    const next = app.commit(commands, revision);
    await response;
    return next;
  });
  const discoveries = fresh(48);
  await app.deliver(scene(discoveries), 200);
  expect(app.calls.map((batch) => batch.length)).toEqual([40]);
  // The browser closes with only the pre-acceptance workspace saved.
  const lastSaved = throughBrowser(app.latest());
  const writes = app.saved.length;
  await act(async () => root?.unmount());
  root = undefined;
  await act(async () => respond());
  await flush();
  expect(app.saved).toHaveLength(writes);

  // Reopen: the account room carries the committed batch and its bookkeeping.
  const reopened = await mount({ workspace: lastSaved, server: app.server() });
  await reopened.connect(async (commands, revision) =>
    reopened.commit(commands, revision),
  );
  await reopened.deliver(scene(discoveries), 200);
  await flush();
  expect(reopened.calls.map((batch) => batch.length)).toEqual([9]);
  expect(reopened.server().reconstruction).toEqual({
    generation: 200,
    applied: [lamp.objectId, ...discoveries.map((item) => item.objectId)],
    retired: [{ id: lamp.objectId, generation: 200 }],
    deleted: [],
  });
  expect(reopened.sceneShown()).toBe(true);

  // A later generation that omits every discovery retires all 48.
  const again = throughBrowser(reopened.latest());
  await act(async () => root?.unmount());
  root = undefined;
  const later = await mount({ workspace: again, server: reopened.server() });
  await later.connect(async (commands, revision) =>
    later.commit(commands, revision),
  );
  await later.deliver(scene([]), 300);
  await flush();
  expect(later.calls.map((batch) => batch.length)).toEqual([40, 8]);
  expect(
    later.server().objects.filter((item) => item.detectionSource === "photo"),
  ).toEqual([]);
  expect(later.server().reconstruction?.deleted).toEqual([]);
  expect(later.server().reconstruction?.retired).toHaveLength(49);
});
