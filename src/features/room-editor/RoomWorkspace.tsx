import {
  lazy,
  useCallback,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Download, MessageCircle, Undo2, Upload } from "lucide-react";
import {
  importRoomPlan,
  MAX_CAPTURE_BYTES,
  parseRoomFile,
  roomPlanSchema,
  savedRoomSchema,
  type SavedRoom,
} from "../../../shared/capture/roomplan";
import { createWalkthrough } from "../../../shared/capture/walkthrough";
import type { WalkInput } from "./FirstPersonCamera";
import { WalkControls } from "./WalkControls";
import type { CapturedRoom, RoomObject } from "../../../shared/contracts";
import { syntheticRoomPlan } from "../../../shared/fixtures/roomplan";
import {
  Button,
  FloatingPanel,
  Muted,
  Notice,
  Pill,
  TopBar,
  cx,
} from "../../ui";
import type { ChatContext } from "../chat/ChatPanel";
import { ScanAction, StartScreen } from "../room-setup/StartScreen";
import { ScanDock } from "./ScanDock";
import { ViewerTools, type ViewMode } from "./ViewerTools";

const RoomViewer = lazy(() =>
  import("./RoomViewer").then((module) => ({ default: module.RoomViewer })),
);

type Workspace = SavedRoom & { room: CapturedRoom };

function readSaved(key: string): Workspace | null {
  try {
    const text = localStorage.getItem(key);
    if (!text) return null;
    const result = savedRoomSchema.safeParse(JSON.parse(text));
    return result.success && result.data.room.shape === "polygon"
      ? { ...result.data, room: result.data.room }
      : null;
  } catch {
    return null;
  }
}

/**
 * The whole app frame: top bar, then either the start screen or the room
 * review. `scan` renders the phone-pairing control for a given placement and
 * receives the uploaded room text; it is omitted when pairing is unavailable.
 * `chat` renders the design chat, which floats at the right of either screen.
 */
export function RoomWorkspace({
  identity = "local",
  account,
  scan,
  chat,
}: {
  identity?: string;
  account?: ReactNode;
  scan?: (
    placement: "start" | "bar",
    receive: (text: string) => void,
  ) => ReactNode;
  chat: (context: ChatContext) => ReactNode;
}) {
  const key = `rumi.room.v1.${identity}`;
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    readSaved(key),
  );
  const [chatOpen, setChatOpen] = useState(() => workspace !== null);
  const [history, setHistory] = useState<(Workspace | null)[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const [view, setView] = useState<ViewMode>("3d");
  const [walking, setWalking] = useState(false);
  const [walkSession, setWalkSession] = useState(0);
  const walkInput = useRef<WalkInput>({ pressed: new Set() });
  const root = useRef<HTMLDivElement>(null);
  const [wallsVisible, setWallsVisible] = useState(true);
  const [dimensionsVisible, setDimensionsVisible] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const room = workspace?.room;
  const walkthrough = useMemo(
    () => (room ? createWalkthrough(room) : null),
    [room],
  );
  const exitWalk = useCallback(() => {
    setWalking(false);
    walkInput.current.pressed.clear();
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>("[data-walk-entry]")
        ?.focus(),
    );
  }, []);
  function enterWalk() {
    if (!walkthrough?.start) {
      setError(
        "First person needs a flat captured floor with enough clear space to stand. Try a more complete room scan.",
      );
      return;
    }
    setError("");
    setWalking(true);
  }

  function persist(next: Workspace | null) {
    setWorkspace(next);
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
      setStatus("Saved on this browser");
    } catch {
      setStatus(
        "Browser storage is full or unavailable. Download your room to keep these changes.",
      );
    }
  }
  function commit(next: Workspace | null) {
    setHistory((previous) => [...previous.slice(-9), workspace]);
    persist(next);
    setError("");
    if (next && !workspace) setChatOpen(true);
  }
  function loadText(text: string, name: string) {
    const next = parseRoomFile(text, name);
    if (next.room.shape !== "polygon")
      throw new Error(
        "This viewer opens RoomPlan captures. Choose a RoomPlan JSON or saved captured room.",
      );
    commit({ ...next, room: next.room });
    setSelected(null);
    setWalking(false);
  }
  async function importFile(file?: File) {
    if (!file) return;
    const request = ++importRequest.current;
    setBusy(true);
    setError("");
    try {
      if (file.size > MAX_CAPTURE_BYTES)
        throw new Error("Choose a JSON file smaller than 10 MB.");
      const text = await file.text();
      if (request === importRequest.current) loadText(text, file.name);
    } catch (cause) {
      if (request === importRequest.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not import this file.",
        );
    } finally {
      if (request === importRequest.current) setBusy(false);
    }
  }
  function sample() {
    ++importRequest.current;
    setBusy(false);
    commit({
      format: "rumi.room",
      version: 1,
      room: importRoomPlan(syntheticRoomPlan, "The corner living room", true),
      original: roomPlanSchema.passthrough().parse(syntheticRoomPlan),
    });
    setSelected(null);
  }
  function editObjects(objects: RoomObject[]) {
    if (workspace)
      commit({
        ...workspace,
        room: {
          ...workspace.room,
          revision: workspace.room.revision + 1,
          objects,
        },
      });
  }
  function download() {
    if (!workspace) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(workspace, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "rumi-room.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function undo() {
    if (!history.length) return;
    persist(history[history.length - 1]);
    setHistory((previous) => previous.slice(0, -1));
    setSelected(null);
  }
  function receive(text: string) {
    ++importRequest.current;
    setBusy(false);
    try {
      loadText(text, "My scanned room");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not import uploaded room.",
      );
      throw cause;
    }
  }

  const original = workspace?.original;
  const originalObjects = useMemo(
    () => (original ? importRoomPlan(original).objects : []),
    [original],
  );
  const originalObject = (id: string) =>
    originalObjects.find((item) => item.id === id);
  const chatToggle = (
    <Button
      aria-pressed={chatOpen}
      onClick={() => setChatOpen((value) => !value)}
    >
      <MessageCircle /> Design chat
    </Button>
  );
  /** Keeps floating controls clear of the chat panel while it is open. */
  const clearChat = chatOpen ? "right-4 lg:right-[328px]" : "right-4";
  const chatDock = chatOpen && (
    <FloatingPanel
      aria-label="Design chat"
      inert={walking}
      aria-hidden={walking}
      className={cx(
        "right-4 bottom-4 flex w-[296px] max-w-[calc(100%-32px)] flex-col overflow-hidden p-0 transition-[translate,opacity] duration-400 ease-in-out motion-reduce:transition-none",
        room ? "top-28 lg:top-4" : "top-4",
        walking &&
          "translate-x-[calc(100%+32px)] opacity-0 pointer-events-none",
      )}
    >
      {chat({ room, onCollapse: () => setChatOpen(false) })}
    </FloatingPanel>
  );

  return (
    <div
      ref={root}
      className={cx(
        "flex h-dvh flex-col bg-chalk",
        room ? "overflow-hidden" : "overflow-auto",
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!walking) void importFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Import room JSON"
        inert={walking}
        aria-hidden={walking}
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {!room ? (
        <>
          <TopBar>
            {chatToggle}
            {account}
          </TopBar>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <StartScreen
              busy={busy}
              onImport={() => fileInput.current?.click()}
              onSample={sample}
              scan={
                scan ? (
                  // eslint-disable-next-line react-hooks/refs -- scan renders a control; receive runs only when a scan arrives.
                  scan("start", receive)
                ) : (
                  <ScanAction
                    onClick={() => setNotice(true)}
                    note="Pairing is not set up here yet. Export the scan from your phone and import it."
                  />
                )
              }
            />
            {notice && (
              <Notice tone="info" floating onDismiss={() => setNotice(false)}>
                Phone pairing is not configured. Export the RoomPlan JSON from
                your phone and import it here.
              </Notice>
            )}
            {error && (
              <Notice tone="error" floating onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            {chatDock}
          </div>
        </>
      ) : (
        <>
          <div
            inert={walking}
            aria-hidden={walking}
            className={cx(
              "grid shrink-0 transition-[grid-template-rows,opacity] duration-400 ease-in-out motion-reduce:transition-none",
              walking
                ? "grid-rows-[0fr] opacity-0"
                : "grid-rows-[1fr] opacity-100",
            )}
          >
            <div className="min-h-0 overflow-x-auto">
              <TopBar
                className="min-w-max"
                title={
                  <>
                    {room.name}
                    {room.capture.synthetic && <Pill>sample</Pill>}
                  </>
                }
              >
                {status && <Muted className="text-xs">{status}</Muted>}
                {chatToggle}
                <Button disabled={!history.length} onClick={undo}>
                  <Undo2 /> Undo
                </Button>
                <Button onClick={download}>
                  <Download /> Download room
                </Button>
                {// eslint-disable-next-line react-hooks/refs -- scan renders a control; receive runs only when a scan arrives.
                scan?.("bar", receive)}
                <Button
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload />
                  {busy ? "Importing…" : "Import a scan"}
                </Button>
                {account}
              </TopBar>
            </div>
          </div>

          <main
            className="relative min-h-0 flex-1 bg-sage"
            aria-label="Room view"
            data-view={walking ? "first-person" : view}
          >
            <div className="absolute inset-0">
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-mute">
                    Preparing your room…
                  </div>
                }
              >
                <RoomViewer
                  room={room}
                  selected={walking ? null : selected}
                  onSelect={setSelected}
                  top={view === "plan"}
                  wallsVisible={walking || wallsVisible}
                  dimensionsVisible={!walking && dimensionsVisible}
                  walkthrough={walking ? walkthrough : null}
                  walkInput={walkInput}
                  walkSession={walkSession}
                />
              </Suspense>
            </div>

            {error && (
              <Notice tone="error" floating onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}

            <ScanDock
              hidden={walking}
              room={room}
              selected={selected}
              onSelect={setSelected}
              originalObject={originalObject}
              onSave={(next) =>
                editObjects(
                  room.objects.map((item) =>
                    item.id === next.id ? next : item,
                  ),
                )
              }
              onReset={(id) => {
                const source = originalObject(id);
                if (source)
                  editObjects(
                    room.objects.map((item) =>
                      item.id === id ? source : item,
                    ),
                  );
              }}
              onRemove={(id) => {
                editObjects(room.objects.filter((item) => item.id !== id));
                setSelected(null);
              }}
            />

            <ViewerTools
              view={view}
              hidden={walking}
              onWalk={enterWalk}
              onView={setView}
              walls={wallsVisible}
              onWalls={setWallsVisible}
              dimensions={dimensionsVisible}
              onDimensions={setDimensionsVisible}
              className={clearChat}
            />

            <div
              inert={walking}
              aria-hidden={walking}
              className={cx(
                walking && "translate-y-20 opacity-0 pointer-events-none",
                "transition-[translate,opacity] duration-400 motion-reduce:transition-none absolute bottom-4 z-10 flex gap-3 rounded-full bg-chalk/80 px-2.5 py-[5px] text-[11px] text-[#3f5049]",
                clearChat,
              )}
            >
              <span>
                Walls are from the scan. Ceiling height{" "}
                {room.dimensions.height.toFixed(2)} m.
              </span>
              <span>
                {view === "plan"
                  ? "Scroll to zoom, drag to pan."
                  : "Drag to orbit, scroll to zoom, right-drag to pan."}
              </span>
            </div>
            {chatDock}
            {walking && (
              <WalkControls
                name={room.name}
                synthetic={room.capture.synthetic}
                input={walkInput}
                onExit={exitWalk}
                onReset={() => {
                  walkInput.current.pressed.clear();
                  setWalkSession((value) => value + 1);
                }}
              />
            )}
          </main>
        </>
      )}
    </div>
  );
}
