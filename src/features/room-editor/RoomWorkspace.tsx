import {
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Download, Undo2, Upload } from "lucide-react";
import {
  importRoomPlan,
  MAX_CAPTURE_BYTES,
  parseRoomFile,
  roomPlanSchema,
  savedRoomSchema,
  type SavedRoom,
} from "../../../shared/capture/roomplan";
import type { CapturedRoom, RoomObject } from "../../../shared/contracts";
import { syntheticRoomPlan } from "../../../shared/fixtures/roomplan";
import { Button, Muted, Notice, Pill, TopBar } from "../../ui";
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
 */
export function RoomWorkspace({
  identity = "local",
  account,
  scan,
}: {
  identity?: string;
  account?: ReactNode;
  scan?: (
    placement: "start" | "bar",
    receive: (text: string) => void,
  ) => ReactNode;
}) {
  const key = `rumi.room.v1.${identity}`;
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    readSaved(key),
  );
  const [history, setHistory] = useState<(Workspace | null)[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const [view, setView] = useState<ViewMode>("3d");
  const [wallsVisible, setWallsVisible] = useState(true);
  const [dimensionsVisible, setDimensionsVisible] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const room = workspace?.room;

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
  }
  function loadText(text: string, name: string) {
    const next = parseRoomFile(text, name);
    if (next.room.shape !== "polygon")
      throw new Error(
        "This viewer opens RoomPlan captures. Choose a RoomPlan JSON or saved captured room.",
      );
    commit({ ...next, room: next.room });
    setSelected(null);
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

  return (
    <div
      className="flex h-full flex-col bg-chalk"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void importFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Import room JSON"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {!room ? (
        <>
          <TopBar>{account}</TopBar>
          <StartScreen
            busy={busy}
            onImport={() => fileInput.current?.click()}
            onSample={sample}
            scan={
              scan ? (
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
            <Notice
              tone="info"
              floating
              onDismiss={() => setNotice(false)}
              className="top-[72px]"
            >
              Phone pairing is not configured. Export the RoomPlan JSON from
              your phone and import it here.
            </Notice>
          )}
          {error && (
            <Notice
              tone="error"
              floating
              onDismiss={() => setError("")}
              className="top-[72px]"
            >
              {error}
            </Notice>
          )}
        </>
      ) : (
        <>
          <TopBar
            title={
              <>
                {room.name}
                {room.capture.synthetic && <Pill>sample</Pill>}
              </>
            }
          >
            {status && <Muted className="text-xs">{status}</Muted>}
            <Button disabled={!history.length} onClick={undo}>
              <Undo2 /> Undo
            </Button>
            <Button onClick={download}>
              <Download /> Download room
            </Button>
            {scan?.("bar", receive)}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload />
              {busy ? "Importing…" : "Import a scan"}
            </Button>
            {account}
          </TopBar>

          <main
            className="relative min-h-0 flex-1 bg-sage"
            aria-label="Room view"
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
                  selected={selected}
                  onSelect={setSelected}
                  top={view === "plan"}
                  wallsVisible={wallsVisible}
                  dimensionsVisible={dimensionsVisible}
                />
              </Suspense>
            </div>

            {error && (
              <Notice tone="error" floating onDismiss={() => setError("")}>
                {error}
              </Notice>
            )}

            <ScanDock
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
              onView={setView}
              walls={wallsVisible}
              onWalls={setWallsVisible}
              dimensions={dimensionsVisible}
              onDimensions={setDimensionsVisible}
            />

            <div className="absolute right-4 bottom-4 z-10 flex gap-3 rounded-full bg-chalk/80 px-2.5 py-[5px] text-[11px] text-[#3f5049]">
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
          </main>
        </>
      )}
    </div>
  );
}
