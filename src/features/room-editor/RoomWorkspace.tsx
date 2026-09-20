import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import { MAX_PACKAGE_BYTES } from "../../../shared/capture/package";
import type { TexturedScan } from "../../../shared/capture/texture";
import { processScan, downloadScan } from "./capture/processing";
import { readScan, saveScan } from "./capture/storage";
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

type Workspace = SavedRoom & { room: CapturedRoom; scanId?: string };
const localWorkspaceSchema = savedRoomSchema.safeExtend({
  scanId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});
type ScanResource = {
  id: string;
  blob?: Blob;
  scan?: TexturedScan;
  error?: string;
  persisted?: boolean;
};

function readSaved(key: string): Workspace | null {
  try {
    const text = localStorage.getItem(key);
    if (!text) return null;
    const result = localWorkspaceSchema.safeParse(JSON.parse(text));
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
 * receives the uploaded room file; it is omitted when pairing is unavailable.
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
    receive: (file: File) => Promise<void>,
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
  const [showScan, setShowScan] = useState(true);
  const [capture, setCapture] = useState<ScanResource | null>(null);
  const activeImport = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const room = workspace?.room;
  const scanId = workspace?.scanId;
  const resource = capture?.id === scanId ? capture : null;
  const scanVisible = showScan && view === "3d" && !!resource?.scan;
  const original = workspace?.original;
  const originalRoom = useMemo(
    () => (original ? importRoomPlan(original) : undefined),
    [original],
  );
  useEffect(() => {
    if (!scanId || capture?.id === scanId) return;
    const controller = new AbortController();
    void readScan(identity, scanId)
      .then(async (blob) => {
        const result = await processScan(blob, controller.signal);
        if (!controller.signal.aborted)
          setCapture({ id: scanId, blob, scan: result.scan });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setCapture({
            id: scanId,
            error:
              cause instanceof Error
                ? cause.message
                : "Could not restore the detailed scan. Import its ZIP again.",
          });
      });
    return () => controller.abort();
  }, [identity, scanId, capture?.id]);
  useEffect(() => () => activeImport.current?.abort(), []);
  const scanError = useCallback((message: string) => {
    setError(message);
    setShowScan(false);
    setWalking(false);
  }, []);
  // Captured surfaces never move with furniture edits. Match collisions to the
  // layout represented by the visible scene, including when walking a ZIP scan.
  const walkRoom = scanVisible ? originalRoom : room;
  const walkthrough = useMemo(
    () => (walkRoom ? createWalkthrough(walkRoom) : null),
    [walkRoom],
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
      setStatus(
        next?.scanId === capture?.id && capture?.persisted === false
          ? "Edits saved. The detailed scan is only in memory; download your room before closing this tab."
          : "Saved on this browser",
      );
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
  async function importFile(file?: File, reportFailure = false) {
    if (!file) return;
    const request = ++importRequest.current;
    activeImport.current?.abort();
    const controller = new AbortController();
    activeImport.current = controller;
    setBusy(true);
    setError("");
    try {
      if (/\.zip$/i.test(file.name)) {
        if (file.size > MAX_PACKAGE_BYTES)
          throw new Error("Choose a scan ZIP smaller than 128 MB.");
        const result = await processScan(file, controller.signal);
        if (request !== importRequest.current) return;
        if (result.saved.room.shape !== "polygon")
          throw new Error("This scan has no room layout.");
        const id = Array.from(
          crypto.getRandomValues(new Uint8Array(16)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        let stored = true;
        try {
          await saveScan(identity, id, file);
        } catch {
          stored = false;
        }
        controller.signal.throwIfAborted();
        if (request !== importRequest.current) return;
        setCapture({ id, blob: file, scan: result.scan, persisted: stored });
        setShowScan(true);
        setView("3d");
        setWalking(false);
        commit({ ...result.saved, room: result.saved.room, scanId: id });
        setSelected(null);
        if (!stored)
          setStatus(
            "The detailed scan is only in memory. Download your room before closing this tab.",
          );
        return;
      }
      if (file.size > MAX_CAPTURE_BYTES)
        throw new Error("Choose a JSON file smaller than 10 MB.");
      const text = await file.text();
      controller.signal.throwIfAborted();
      if (request === importRequest.current) loadText(text, file.name);
    } catch (cause) {
      if (request === importRequest.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not import this file.",
        );
      if (reportFailure) throw cause;
    } finally {
      if (request === importRequest.current) setBusy(false);
    }
  }
  function sample() {
    activeImport.current?.abort();
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
    setShowScan(false);
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
  async function download() {
    if (!workspace) return;
    setBusy(true);
    try {
      // Local asset IDs stay in this browser. A ZIP embeds both the original scan and edits.
      const saved = savedRoomSchema.parse(workspace);
      const blob = workspace.scanId
        ? await downloadScan(
            resource?.blob ?? (await readScan(identity, workspace.scanId)),
            saved,
          )
        : new Blob([JSON.stringify(saved, null, 2)], {
            type: "application/json",
          });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = workspace.scanId ? "rumi-room.zip" : "rumi-room.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not export this room.",
      );
    } finally {
      setBusy(false);
    }
  }
  function undo() {
    if (!history.length) return;
    persist(history[history.length - 1]);
    setHistory((previous) => previous.slice(0, -1));
    setSelected(null);
  }
  async function receive(file: File) {
    await importFile(file, true);
  }

  const originalObject = (id: string) =>
    originalRoom?.objects.find((item) => item.id === id);
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
        accept=".json,.zip,application/json,application/zip"
        className="sr-only"
        aria-label="Import room JSON or scan ZIP"
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
                Phone pairing is not configured. Use Export scan on your phone
                and import the ZIP here to include room photos and surfaces.
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
                <Button disabled={busy} onClick={() => void download()}>
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
                  scan={scanVisible ? resource?.scan : undefined}
                  onScanError={scanError}
                />
              </Suspense>
            </div>

            {error && (
              <Notice tone="error" floating onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}
            {resource?.error && (
              <Notice tone="warn" floating>
                {resource.error}
              </Notice>
            )}
            {scanId && !resource && (
              <Notice tone="info" floating>
                Preparing captured surfaces… You can use the room layout while
                it loads.
              </Notice>
            )}

            <ScanDock
              hidden={walking}
              room={room}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                if (id) setShowScan(false);
              }}
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
              captureWarnings={resource?.scan?.warnings}
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
              scan={
                resource?.scan && view === "3d"
                  ? {
                      visible: showScan,
                      onChange: (value) => {
                        setShowScan(value);
                        if (value) setSelected(null);
                      },
                    }
                  : undefined
              }
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
                {scanVisible && resource?.scan
                  ? `Original captured surfaces. ${Math.round((resource.scan.texturedFaceCount / resource.scan.faceCount) * 100)}% of triangles textured. Edits appear in the layout view.`
                  : `Walls are from the scan. Ceiling height ${room.dimensions.height.toFixed(2)} m.`}
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
