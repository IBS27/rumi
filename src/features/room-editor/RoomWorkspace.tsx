import {
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Box,
  Check,
  Download,
  FileJson,
  Layers,
  Ruler,
  MessageCircle,
  ScanLine,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  importRoomPlan,
  MAX_CAPTURE_BYTES,
  parseRoomFile,
  roomPlanSchema,
  savedRoomSchema,
  type SavedRoom,
} from "../../../shared/capture/roomplan";
import { floorArea } from "../../../shared/capture/surfaces";
import type { CapturedRoom, RoomObject } from "../../../shared/contracts";
import { syntheticRoomPlan } from "../../../shared/fixtures/roomplan";
import type { ChatContext } from "../chat/ChatPanel";
import { ObjectInspector } from "./ObjectInspector";

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

export function RoomWorkspace({
  identity = "local",
  account,
  phone,
  chat,
}: {
  identity?: string;
  account?: ReactNode;
  phone?: (receive: (text: string) => void) => ReactNode;
  chat: (context: ChatContext) => ReactNode;
}) {
  const [chatOpen, setChatOpen] = useState(true);
  function selectObject(id: string | null) {
    setSelected(id);
    if (id) setChatOpen(false);
  }
  const key = `rumi.room.v1.${identity}`;
  const [workspace, setWorkspace] = useState<Workspace | null>(() =>
    readSaved(key),
  );
  const [history, setHistory] = useState<(Workspace | null)[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [top, setTop] = useState(false);
  const [wallsVisible, setWallsVisible] = useState(true);
  const [dimensionsVisible, setDimensionsVisible] = useState(false);
  const [notice, setNotice] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const room = workspace?.room;
  const object = room?.objects.find((item) => item.id === selected);
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
  const original = workspace?.original;
  const originalObjects = useMemo(
    () => (original ? importRoomPlan(original).objects : []),
    [original],
  );
  const originalObject = originalObjects.find((item) => item.id === object?.id);
  return (
    <div
      className="app-shell"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void importFile(event.dataTransfer.files[0]);
      }}
    >
      <header className="app-header">
        <a href="#" className="brand" aria-label="Rumi home">
          rumi<span>spaces, understood.</span>
        </a>
        <div className="header-actions">
          <button
            aria-pressed={chatOpen}
            onClick={() => setChatOpen((value) => !value)}
          >
            <MessageCircle size={16} /> Design chat
          </button>
          {account}
          <span className="header-divider" />
          {phone ? (
            phone((text) => {
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
            })
          ) : (
            <button onClick={() => setNotice(true)}>
              <ScanLine size={16} /> Scan with iPhone
            </button>
          )}
          <button
            className="primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            {busy ? "Importing…" : "Import room"}
          </button>
        </div>
      </header>
      <div className={`room-layout ${chatOpen ? "with-chat" : ""}`}>
        <div className="room-main">
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
          {error && (
            <div role="alert" className="error-banner">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="connection-notice" role="status">
              Phone pairing is not configured yet. You can export JSON from your
              phone and import it here.
              <button
                onClick={() => setNotice(false)}
                aria-label="Dismiss connection notice"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!room ? (
            <main className="empty-state">
              <div className="eyebrow">YOUR ROOM, IN PERSPECTIVE</div>
              <h1>
                Start with the space
                <br />
                you already have.
              </h1>
              <p>
                Bring in a room scan. Explore its shape, inspect your furniture,
                and make the measurements your own.
              </p>
              <div className="empty-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={17} /> Import a room scan
                </button>
                <button onClick={sample}>
                  Explore a sample room <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="sample-note">
                <FileJson size={18} />
                <div>
                  Drop a RoomPlan JSON file anywhere
                  <span>Or try our synthetic living room. No scan needed.</span>
                </div>
              </div>
              <div className="steps">
                <div>
                  <span>01</span>
                  <strong>Capture your space</strong>
                  <p>Scan with a LiDAR iPhone.</p>
                </div>
                <div>
                  <span>02</span>
                  <strong>See what’s there</strong>
                  <p>Walls, openings, and furniture.</p>
                </div>
                <div>
                  <span>03</span>
                  <strong>Make it accurate</strong>
                  <p>Review and correct measurements.</p>
                </div>
              </div>
            </main>
          ) : (
            <>
              <div className="room-heading">
                <div>
                  <div className="eyebrow">
                    ROOM WORKSPACE{" "}
                    {room.capture.synthetic && (
                      <span className="sample-tag">SYNTHETIC SAMPLE</span>
                    )}
                  </div>
                  <h1>{room.name}</h1>
                  <p>
                    {room.walls.length} wall segments <span>·</span>{" "}
                    {room.objects.length} existing objects <span>·</span>{" "}
                    {room.floors.length
                      ? `${floorArea(room.floors).toFixed(1)} m² captured floor area`
                      : "Floor boundary unavailable"}
                  </p>
                </div>
                <div className="room-actions">
                  <button disabled={!history.length} onClick={undo}>
                    <Undo2 size={16} /> Undo
                  </button>
                  <button onClick={download}>
                    <Download size={16} /> Download room
                  </button>
                </div>
              </div>
              <main className="workspace-grid">
                <aside className="object-list">
                  <div className="panel-heading">
                    <span>Existing furniture</span>
                    <span>{room.objects.length}</span>
                  </div>
                  <p className="muted small">
                    Select an object to inspect its measurements.
                  </p>
                  <div className="object-buttons">
                    {room.objects.map((item) => (
                      <button
                        key={item.id}
                        className={`object-button ${selected === item.id ? "is-selected" : ""}`}
                        onClick={() => selectObject(item.id)}
                        aria-pressed={selected === item.id}
                      >
                        <span className="object-icon">
                          <Box size={19} />
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.dimensions.width.toFixed(2)} ×{" "}
                            {item.dimensions.depth.toFixed(2)} m
                          </small>
                        </span>
                        {item.measurementSource === "confirmed" && (
                          <Check size={14} aria-label="Verified dimensions" />
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="list-footer">
                    <span className="eyebrow">ROOM EXTENTS</span>
                    <p>
                      {room.dimensions.width.toFixed(2)} ×{" "}
                      {room.dimensions.depth.toFixed(2)} ×{" "}
                      {room.dimensions.height.toFixed(2)} m
                    </p>
                    <small>
                      Overall bounds, including any recesses. Measurements are
                      scan estimates.
                    </small>
                  </div>
                </aside>
                <section className="viewer-panel" aria-label="Room view">
                  <div className="viewer-toolbar">
                    <div className="segmented">
                      <button aria-pressed={!top} onClick={() => setTop(false)}>
                        3D view
                      </button>
                      <button aria-pressed={top} onClick={() => setTop(true)}>
                        Floor plan
                      </button>
                    </div>
                    <div className="view-options">
                      <button
                        aria-label="Show walls"
                        aria-pressed={wallsVisible}
                        onClick={() => setWallsVisible((value) => !value)}
                      >
                        <Layers size={16} />
                        <span>Walls</span>
                      </button>
                      <button
                        aria-label="Show dimensions"
                        aria-pressed={dimensionsVisible}
                        onClick={() => setDimensionsVisible((value) => !value)}
                      >
                        <Ruler size={16} />
                        <span>Dimensions</span>
                      </button>
                    </div>
                  </div>
                  <div className="canvas-container">
                    <Suspense
                      fallback={
                        <div className="viewer-fallback">
                          Preparing your room…
                        </div>
                      }
                    >
                      <RoomViewer
                        room={room}
                        selected={selected}
                        onSelect={selectObject}
                        top={top}
                        wallsVisible={wallsVisible}
                        dimensionsVisible={dimensionsVisible}
                      />
                    </Suspense>
                  </div>
                  <div className="viewer-caption">
                    <span>
                      {top
                        ? "Scroll to zoom · Drag to pan"
                        : "Drag to orbit · Scroll to zoom · Right-drag to pan"}
                    </span>
                    <span>Approximate furniture shapes</span>
                  </div>
                </section>
                {object ? (
                  <ObjectInspector
                    key={`${object.id}-${room.revision}`}
                    object={object}
                    original={!!originalObject}
                    onSave={(next) =>
                      editObjects(
                        room.objects.map((item) =>
                          item.id === next.id ? next : item,
                        ),
                      )
                    }
                    onRemove={() => {
                      editObjects(
                        room.objects.filter((item) => item.id !== object.id),
                      );
                      setSelected(null);
                    }}
                    onReset={() => {
                      if (originalObject)
                        editObjects(
                          room.objects.map((item) =>
                            item.id === object.id ? originalObject : item,
                          ),
                        );
                    }}
                  />
                ) : (
                  <aside className="inspector inspector-empty">
                    <Ruler size={28} />
                    <h2>A closer look</h2>
                    <p>
                      Select furniture in the room or the list to see dimensions
                      and adjust its placement.
                    </p>
                    <div className="measurement-note">
                      <strong>Measurements come first.</strong>
                      <p>
                        These shapes describe the scan’s geometry. They don’t
                        reproduce the exact appearance of your furniture.
                      </p>
                    </div>
                  </aside>
                )}
              </main>
              <footer className="workspace-footer">
                <details>
                  <summary>
                    {room.capture.warnings.length} capture notes
                  </summary>
                  {room.capture.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </details>
                <span role="status">{status || "Stored on this browser"}</span>
              </footer>
            </>
          )}
        </div>
        <aside className="chat-dock" hidden={!chatOpen}>
          {chat({ room, onCollapse: () => setChatOpen(false) })}
        </aside>
      </div>
    </div>
  );
}
