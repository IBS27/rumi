import {
  mergeDiscoveredObjects,
  discoveredRoomObject,
} from "../../../shared/reconstruction/contracts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MAX_PACKAGE_BYTES } from "../../../shared/capture/package";
import type { TexturedScan } from "../../../shared/capture/texture";
import type {
  ReconstructionInput,
  ReconstructedScene,
} from "../../../shared/reconstruction/contracts";
import { processScan, downloadScan } from "./capture/processing";
import { readScan, saveScan } from "./capture/storage";
import { Download, MessageCircle, Undo2, Upload } from "lucide-react";
import {
  importRoomPlan,
  MAX_CAPTURE_BYTES,
  parseRoomFile,
  roomPlanSchema,
  savedRoomSchema,
} from "../../../shared/capture/roomplan";
import type { Workspace } from "../workspace/sessions";
import { createWalkthrough } from "../../../shared/capture/walkthrough";
import type { WalkInput } from "./FirstPersonCamera";
import { WalkControls } from "./WalkControls";
import type { RoomObject } from "../../../shared/contracts";
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

type ScanResource = {
  id: string;
  blob?: Blob;
  scan?: TexturedScan;
  error?: string;
  persisted?: boolean;
  evidence?: ReconstructionInput;
  evidenceError?: string;
  scene?: ReconstructedScene;
};

/**
 * One session's frame: top bar, then either the start screen or the room
 * review. The session shell owns persistence: `initial` is the saved room and
 * `onPersist` stores each change (it throws when storage is unavailable).
 * Remount with a new `key` to switch sessions. `brand` replaces the wordmark
 * in the top bar. `scan` renders the phone-pairing control for a given
 * placement and receives the uploaded room text; it is omitted when pairing is
 * unavailable. `chat` renders the design chat, which floats at the right of
 * either screen.
 */
export function RoomWorkspace({
  identity = "local",
  initial = null,
  onPersist,
  title,
  brand,
  account,
  scan,
  chat,
  reconstruct,
}: {
  identity?: string;
  initial?: Workspace | null;
  onPersist?: (next: Workspace | null) => void;
  /** The session's name control; the room name shows when it is unset. */
  title?: ReactNode;
  brand?: ReactNode;
  account?: ReactNode;
  scan?: (
    placement: "start" | "bar",
    receive: (file: File, signal?: AbortSignal) => Promise<void>,
  ) => ReactNode;
  chat: (context: ChatContext) => ReactNode;
  reconstruct?: (
    input: ReconstructionInput,
    onReady: (scene: ReconstructedScene) => void,
  ) => ReactNode;
}) {
  const [workspace, setWorkspace] = useState<Workspace | null>(initial);
  const [chatOpen, setChatOpen] = useState(() => workspace !== null);
  const chatId = useId();
  const chatLauncher = useRef<HTMLButtonElement>(null);
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
  const [cutaway, setCutaway] = useState(true);
  const [dimensionsVisible, setDimensionsVisible] = useState(false);
  const [showScan, setShowScan] = useState(true);
  const [showSimulation, setShowSimulation] = useState(true);
  const [capture, setCapture] = useState<ScanResource | null>(null);
  const activeImport = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const room = workspace?.room;
  const scanId = workspace?.scanId;
  const resource = capture?.id === scanId ? capture : null;
  const simulationVisible =
    showSimulation && view === "3d" && !!resource?.scene;
  const scanVisible =
    !simulationVisible && showScan && view === "3d" && !!resource?.scan;
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
          setCapture({
            id: scanId,
            blob,
            scan: result.scan,
            evidence: result.evidence,
            evidenceError: result.evidenceError,
          });
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
      onPersist?.(next);
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
  async function importFile(
    file?: File,
    propagate = false,
    signal?: AbortSignal,
  ) {
    if (!file) return;
    signal?.throwIfAborted();
    const request = ++importRequest.current;
    activeImport.current?.abort();
    const controller = new AbortController();
    activeImport.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    setBusy(true);
    setError("");
    try {
      if (/\.zip$/i.test(file.name)) {
        if (file.size > MAX_PACKAGE_BYTES)
          throw new Error("Choose a scan ZIP smaller than 128 MB.");
        const result = await processScan(file, controller.signal);
        controller.signal.throwIfAborted();
        if (request !== importRequest.current)
          throw new DOMException("Import superseded.", "AbortError");
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
        if (request !== importRequest.current)
          throw new DOMException("Import superseded.", "AbortError");
        setCapture({
          id,
          blob: file,
          scan: result.scan,
          persisted: stored,
          evidence: result.evidence,
          evidenceError: result.evidenceError,
        });
        setShowScan(true);
        setShowSimulation(true);
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
      if (request !== importRequest.current)
        throw new DOMException("Import superseded.", "AbortError");
      loadText(text, file.name);
    } catch (cause) {
      if (request === importRequest.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not import this file.",
        );
      if (propagate) throw cause;
    } finally {
      signal?.removeEventListener("abort", abort);
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
  async function receive(file: File, signal?: AbortSignal) {
    await importFile(file, true, signal);
  }

  const originalObject = (id: string) =>
    originalRoom?.objects.find((item) => item.id === id) ??
    resource?.scene?.discoveredObjects
      ?.filter((item) => item.objectId === id)
      .map(discoveredRoomObject)[0];
  /** Keeps floating controls clear of the chat panel while it is open. */
  const clearChat = chatOpen ? "right-4 lg:right-[392px]" : "right-4";
  const chatDock = (
    <>
      <Button
        ref={chatLauncher}
        variant="primary"
        aria-label="Open chat"
        title="Open chat"
        aria-expanded={chatOpen}
        aria-controls={chatId}
        inert={chatOpen || walking}
        aria-hidden={chatOpen || walking}
        onClick={() => {
          setChatOpen(true);
          requestAnimationFrame(() => {
            root.current
              ?.querySelector<HTMLButtonElement>('[aria-label="Collapse chat"]')
              ?.focus({ preventScroll: true });
          });
        }}
        className={cx(
          "absolute top-4 right-4 z-20 size-11 !rounded-panel !p-0 shadow-lift !transition-[scale,opacity,background-color] duration-250 ease-out motion-reduce:transition-none [&>svg]:!size-5",
          chatOpen || walking
            ? "pointer-events-none scale-75 opacity-0"
            : "scale-100 opacity-100",
        )}
      >
        <MessageCircle aria-hidden="true" strokeWidth={1.75} />
      </Button>
      <FloatingPanel
        id={chatId}
        aria-label="Design chat"
        inert={!chatOpen || walking}
        aria-hidden={!chatOpen || walking}
        className={cx(
          "right-4 bottom-4 flex w-[360px] max-w-[calc(100%-32px)] origin-top-right flex-col overflow-hidden !bg-chalk !p-0 transition-[scale,translate,opacity,visibility] duration-250 ease-out motion-reduce:transition-none",
          room ? "top-28 lg:top-4" : "top-4",
          chatOpen
            ? "visible scale-100 opacity-100"
            : "invisible pointer-events-none scale-90 opacity-0",
          walking &&
            "translate-x-[calc(100%+32px)] opacity-0 pointer-events-none",
        )}
      >
        {
          // eslint-disable-next-line react-hooks/refs -- chat renders the panel; onCollapse reads the launcher ref only after interaction.
          chat({
            room,
            onCollapse: () => {
              setChatOpen(false);
              requestAnimationFrame(() => {
                chatLauncher.current?.focus({ preventScroll: true });
              });
            },
          })
        }
      </FloatingPanel>
    </>
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
          <TopBar brand={brand} title={title}>
            {account}
          </TopBar>
          <div className="relative isolate flex min-h-0 flex-1 flex-col">
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
                brand={brand}
                title={
                  <>
                    {title ?? room.name}
                    {room.capture.synthetic && <Pill>sample</Pill>}
                  </>
                }
              >
                {status && <Muted className="text-xs">{status}</Muted>}
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
            className="relative isolate min-h-0 flex-1 bg-sage"
            aria-label="Room view"
            data-view={walking ? "first-person" : view}
          >
            <div
              className={cx(
                "absolute inset-0",
                chatOpen && !walking && "lg:right-[376px]",
              )}
            >
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
                  wallsVisible={wallsVisible}
                  cutaway={cutaway}
                  dimensionsVisible={!walking && dimensionsVisible}
                  walkthrough={walking ? walkthrough : null}
                  walkInput={walkInput}
                  walkSession={walkSession}
                  scan={scanVisible ? resource?.scan : undefined}
                  reconstruction={
                    simulationVisible ? resource?.scene : undefined
                  }
                  onScanError={scanError}
                />
              </Suspense>
            </div>

            {resource?.evidence &&
              !room.capture.synthetic &&
              !resource.scene &&
              reconstruct && (
                <div key={resource.id} hidden={walking}>
                  {reconstruct(resource.evidence, (scene) => {
                    if (!workspace || workspace.scanId !== resource.id) return;
                    const merged = mergeDiscoveredObjects(
                      workspace.room,
                      scene,
                      workspace.reconstructionObjectIds,
                    );
                    persist({ ...workspace, ...merged });
                    setCapture((current) =>
                      current?.id === resource.id
                        ? { ...current, scene }
                        : current,
                    );
                    setShowSimulation(true);
                    setShowScan(false);
                  })}
                </div>
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
              cutaway={{ visible: cutaway, onChange: setCutaway }}
              onWalls={setWallsVisible}
              dimensions={dimensionsVisible}
              onDimensions={setDimensionsVisible}
              className={chatOpen ? clearChat : "right-20"}
              simulation={
                resource?.scene && view === "3d"
                  ? {
                      visible: showSimulation,
                      onChange: (value) => {
                        setShowSimulation(value);
                        if (value) setShowScan(false);
                      },
                    }
                  : undefined
              }
              scan={
                resource?.scan && view === "3d"
                  ? {
                      visible: showScan,
                      onChange: (value) => {
                        setShowScan(value);
                        if (value) setShowSimulation(false);
                        if (value) setSelected(null);
                      },
                    }
                  : undefined
              }
            >
              {error && (
                <Notice tone="error" onDismiss={() => setError("")}>
                  {error}
                </Notice>
              )}
              {resource?.error && <Notice tone="warn">{resource.error}</Notice>}
              {resource?.evidenceError && (
                <Notice tone="warn">{resource.evidenceError}</Notice>
              )}
              {resource?.evidence &&
                !room.capture.synthetic &&
                !reconstruct &&
                !resource.scene && (
                  <Notice>
                    Sign in to create a simulated room from this scan.
                  </Notice>
                )}
              {scanId && !resource && (
                <Notice tone="info">
                  Preparing captured surfaces… You can use the room layout while
                  it loads.
                </Notice>
              )}
            </ViewerTools>

            <div
              inert={walking}
              aria-hidden={walking}
              className={cx(
                walking && "translate-y-20 opacity-0 pointer-events-none",
                "transition-[translate,opacity] duration-400 motion-reduce:transition-none absolute left-4 bottom-4 z-10 flex justify-center",
                clearChat,
              )}
            >
              <span className="text-center text-[11px] text-mute">
                {view === "plan"
                  ? "Scroll to zoom · Drag to pan"
                  : "Drag to orbit · Scroll to zoom · Right-drag to pan"}
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
