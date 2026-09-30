import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { RoomWorkspace } from "../src/features/room-editor/RoomWorkspace";
import { ChatPanel } from "../src/features/chat/ChatPanel";
import { readPackage } from "../shared/capture/package";
import { applyDesignCommands, type DesignCommand } from "../shared/design";
import { buildReconstructionEvidence } from "../shared/reconstruction/evidence";
import {
  reconstructedSceneSchema,
  type ReconstructedScene,
} from "../shared/reconstruction/contracts";
import { sampleBrief } from "../shared/fixtures";
import type { DesignState } from "../shared/design/state";
import type { Workspace } from "../src/features/workspace/sessions";
import { syntheticCaptureZip } from "./fixtures/capture-package";

// A cached reconstruction can finish before the cloud design subscription loads.
const dom = new Window({ url: "http://localhost" });
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
  Worker: undefined as unknown,
};
const previous = new Map(
  Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
let root: Root | undefined;
let client: ConvexReactClient | undefined;
beforeEach(() => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  dom.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  await client?.close();
  client = undefined;
  dom.document.body.innerHTML = "";
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
afterAll(() => dom.happyDOM.abort());

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("commits discoveries through the account once a cloud project's design loads", async () => {
  const capture = readPackage(syntheticCaptureZip());
  const evidence = await buildReconstructionEvidence(capture, async () => ({
    jpeg: "/9j/2Q==",
    width: 32,
    height: 32,
  }));
  if (evidence.room.shape !== "polygon") throw new Error("Missing room");
  // Synthetic rooms skip reconstruction, so present this one as a real scan.
  const room = {
    ...evidence.room,
    capture: { ...evidence.room.capture, synthetic: false },
  };
  evidence.room = room;
  // The scan worker cannot run here; answer with the parsed package directly.
  globals.Worker = class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage() {
      setTimeout(() =>
        this.onmessage?.({
          data: { kind: "import", saved: capture.saved, scan: {}, evidence },
        }),
      );
    }
    terminate() {}
  };
  Object.defineProperty(globalThis, "Worker", {
    value: globals.Worker,
    configurable: true,
    writable: true,
  });
  const projectId = "a".repeat(32);
  const scene: ReconstructedScene = reconstructedSceneSchema.parse({
    version: 1,
    model: "gpt-6-astra",
    roomId: room.id,
    surfaces: [],
    objects: [],
    notes: [],
    discoveredObjects: [
      {
        objectId: "photo-lamp",
        name: "Bedside lamp",
        category: "lighting",
        dimensions: { width: 0.25, height: 0.5, depth: 0.25 },
        position: { x: 1, y: 0.8, z: 1 },
        rotation: { x: 0, y: 0, z: 0 },
        color: "#eee4cc",
        confidence: 0.8,
        evidence: "Visible in photo 0.",
        photoIndices: [0],
      },
    ],
  });
  const initial: Workspace = {
    format: "rumi.room",
    version: 1,
    room,
    scanId: "scan-1",
    cloudProjectId: projectId,
  };
  const state: DesignState = {
    room,
    brief: sampleBrief,
    products: [],
    assets: [],
    recommendations: [],
    canUndo: false,
  };
  const queries: Record<string, unknown> = {
    "projects:context": {
      room,
      brief: sampleBrief,
      phase: "spec",
      project: { title: "Scanned room" },
    },
    "messages:list": { page: [], isDone: true, continueCursor: "" },
  };
  const listeners = new Set<() => void>();
  client = new ConvexReactClient("https://test.convex.cloud", {
    unsavedChangesWarning: false,
  });
  client.watchQuery = (...args) => ({
    onUpdate: (callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    localQueryResult: () => queries[getFunctionName(args[0])],
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  const edits: DesignCommand[][] = [];
  client.mutation = (async (
    reference: Parameters<ConvexReactClient["mutation"]>[0],
    args: { commands: DesignCommand[] },
  ) => {
    expect(getFunctionName(reference)).toBe("design:edit");
    edits.push(args.commands);
    return applyDesignCommands(room, args.commands, [], sampleBrief);
  }) as ConvexReactClient["mutation"];
  const saved: (Workspace | null)[] = [];
  let ready: ((scene: ReconstructedScene) => void) | undefined;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(
      <ConvexProvider client={client!}>
        <RoomWorkspace
          identity="test"
          projectId={projectId}
          initial={initial}
          loadScan={async () => new Blob(["zip"])}
          onPersist={(next) => {
            saved.push(next);
          }}
          reconstruct={(_input, onReady) => {
            ready = onReady;
            return null;
          }}
          chat={(props) => <ChatPanel {...props} identity="test" />}
        />
      </ConvexProvider>,
    );
  });
  await flush();
  expect(ready).toBeDefined();
  await act(async () => ready!(scene));
  await flush();
  // Without the account design, nothing may be written to a local-only copy.
  expect(edits).toEqual([]);
  expect(saved).toEqual([]);

  queries["design:get"] = state;
  await act(async () => listeners.forEach((listener) => listener()));
  await flush();
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject([
    { type: "discover", object: { id: "photo-lamp" } },
  ]);
  expect(saved.at(-1)?.reconstructionObjectIds).toContain("photo-lamp");
});
