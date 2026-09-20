import { afterAll, afterEach, beforeEach, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { RoomWorkspace } from "../src/features/room-editor/RoomWorkspace";
import { ChatPanel } from "../src/features/chat/ChatPanel";
import { importRoomPlan, roomPlanSchema } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { sampleBrief, sampleProducts } from "../shared/fixtures";
import { sampleDesignAssets } from "../shared/fixtures/design";
import type { Workspace } from "../src/features/workspace/sessions";
import type { DesignState } from "../shared/design/state";
import type { CapturedRoom } from "../shared/contracts";

// Exercise React state and actual controls without a deployment or model calls.
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
};
const previous = new Map(
  Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
beforeEach(() => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  dom.localStorage.clear();
});
afterAll(() => dom.happyDOM.abort());

let root: Root | undefined;
let client: ConvexReactClient | undefined;
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

const projectId = "a".repeat(32);
async function mount() {
  const room = importRoomPlan(syntheticRoomPlan, "Connected room", true);
  const initial: Workspace = {
    format: "rumi.room",
    version: 1,
    room,
    original: roomPlanSchema.passthrough().parse(syntheticRoomPlan),
    cloudProjectId: projectId,
  };
  let saved: Workspace | null = initial;
  const state: DesignState = {
    room,
    brief: sampleBrief,
    products: sampleProducts,
    assets: sampleDesignAssets,
    recommendations: sampleProducts.map((product) => ({ product, zone: null })),
    canUndo: true,
  };
  const context = {
    room,
    brief: sampleBrief,
    phase: "spec",
    project: { title: "Test design" },
  };
  const queries: Record<string, unknown> = {
    "projects:context": context,
    "design:get": state,
    "messages:list": { page: [], isDone: true, continueCursor: "" },
  };
  client = new ConvexReactClient("https://test.convex.cloud", {
    unsavedChangesWarning: false,
  });
  client.watchQuery = (...args) => ({
    onUpdate: () => () => {},
    localQueryResult: () => queries[getFunctionName(args[0])],
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  const mutate = mock(async () => projectId);
  client.mutation = mutate;
  dom.localStorage.setItem("rumi.chat.v1.test", projectId);
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(
      <ConvexProvider client={client!}>
        <RoomWorkspace
          initial={initial}
          onPersist={(next) => {
            saved = next;
          }}
          chat={(props) => <ChatPanel {...props} identity="test" />}
        />
      </ConvexProvider>,
    );
  });
  return { room, mutate, saved: () => saved };
}

function button(label: string) {
  const result = [...dom.document.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function importRoom(room: CapturedRoom) {
  const file = new File(
    [
      JSON.stringify({
        format: "rumi.room",
        version: 1,
        room,
        original: syntheticRoomPlan,
      }),
    ],
    "room.json",
    { type: "application/json" },
  );
  const input = dom.document.querySelector(
    'input[type="file"][accept*=".json"]',
  )!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new dom.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("keeps the new-chat composer enabled when disconnecting a saved design", async () => {
  await mount();
  await act(async () => button("New chat").click());
  const composer = dom.document.querySelector(
    'textarea[aria-label="Message Rumi"]',
  )!;
  expect(composer.hasAttribute("disabled")).toBe(false);
  expect(button("Attach inspiration image").disabled).toBe(false);
  // The previous cloud design must still be protected until a chat reconnects.
  expect(button("Undo").disabled).toBe(true);
});

it("places into an imported room without calling the previous cloud connection", async () => {
  const app = await mount();
  const imported = { ...app.room, id: "another-room", name: "Imported room" };
  await importRoom(imported);
  expect(app.saved()?.room.id).toBe(imported.id);
  await act(async () => button("Products · $0").click());
  await act(async () => button("Place in room").click());
  expect(app.mutate).not.toHaveBeenCalled();
  expect(app.saved()?.room.id).toBe(imported.id);
  expect(
    app
      .saved()
      ?.room.objects.some(
        (object) => object.productId === sampleProducts[0].id,
      ),
  ).toBe(true);
});

it.each(["edit", "undo"])(
  "does not overwrite an import with a late %s response",
  async (operation) => {
    const app = await mount();
    let finish!: (room: CapturedRoom) => void;
    const pending = new Promise<CapturedRoom>((resolve) => {
      finish = resolve;
    });
    client!.mutation = async (...args) => {
      expect(getFunctionName(args[0])).toBe(`design:${operation}`);
      return pending;
    };
    if (operation === "edit") {
      await act(async () => button("Products · $0").click());
      await act(async () => button("Place in room").click());
    } else await act(async () => button("Undo").click());
    const imported = { ...app.room, id: "another-room", name: "Imported room" };
    await importRoom(imported);
    const before = app.saved();
    await act(async () => finish({ ...app.room, revision: 1 }));
    expect(app.saved()?.room.id).toBe(imported.id);
    expect(app.saved()).toBe(before);
  },
);
