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
import {
  Download,
  MessageCircle,
  Undo2,
  Upload,
  ShoppingBag,
  X,
} from "lucide-react";
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
import { briefSchema, type RoomObject } from "../../../shared/contracts";
import {
  applyDesignCommands,
  suggestPlacement,
  type DesignCommand,
} from "../../../shared/design";
import { productPlacementIssue } from "../../../shared/design/productPlacement";
import type { DesignState } from "../../../shared/design/state";
import { sampleProducts, sampleBrief } from "../../../shared/fixtures";
import { sampleDesignAssets } from "../../../shared/fixtures/design";
import { formatMoney } from "../../../shared/budget";
import type { DesignConnection } from "./designConnection";
import { DesignPanel } from "./DesignPanel";
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

// getRandomValues also works on the private HTTP preview, unlike randomUUID.
const objectId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

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
  const latestWorkspace = useRef(workspace);
  const persistCallback = useRef(onPersist);
  useEffect(() => {
    persistCallback.current = onPersist;
  }, [onPersist]);
  const [connection, setConnection] = useState<DesignConnection | null>(null);
  const [editing, setEditing] = useState(false);
  const editPending = useRef(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [walkChatOpen, setWalkChatOpen] = useState(false);
  const [preview, setPreview] = useState<RoomObject | null>(null);
  const [previewCorrection, setPreviewCorrection] = useState(false);
  const [previewIssue, setPreviewIssue] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<RoomObject | null>(null);
  const [editMode, setEditMode] = useState<"select" | "move" | "rotate">(
    "select",
  );
  const [snap, setSnap] = useState(true);
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
  const panelOpen = walking ? walkChatOpen : chatOpen;
  const cache = workspace?.design;
  const design: DesignState | null = room
    ? {
        room,
        brief:
          connection?.state.brief ??
          cache?.brief ??
          (room.capture.synthetic
            ? sampleBrief
            : briefSchema.parse({
                prompt: "",
                budgetCents: 0,
                styles: [],
                restrictions: [],
                currency: "USD",
              })),
        products:
          connection?.state.products ??
          cache?.products ??
          (room.capture.synthetic ? sampleProducts : []),
        assets:
          connection?.state.assets ??
          cache?.assets ??
          (room.capture.synthetic ? sampleDesignAssets : []),
        recommendations:
          connection?.state.recommendations ??
          (room.capture.synthetic
            ? sampleProducts.map((product) => ({ product, zone: null }))
            : []),
        canUndo: connection?.state.canUndo ?? history.length > 0,
      }
    : null;
  const disconnected = Boolean(workspace?.cloudProjectId && !connection);
  const editDisabled = editing || disconnected;
  const assets = useMemo(
    () =>
      Object.fromEntries(
        (
          connection?.state.assets ??
          cache?.assets ??
          (room?.capture.synthetic ? sampleDesignAssets : [])
        ).flatMap((asset) =>
          asset.status === "ready" && asset.scene
            ? [[asset.id, asset.scene]]
            : [],
        ),
      ),
    [connection?.state.assets, cache?.assets, room?.capture],
  );
  const connectProject = useCallback((projectId: string) => {
    const current = latestWorkspace.current;
    if (!current || current.cloudProjectId === projectId) return;
    const next = { ...current, cloudProjectId: projectId };
    latestWorkspace.current = next;
    setWorkspace(next);
    persistCallback.current?.(next);
  }, []);
  const acceptDesign = useCallback((next: DesignConnection | null) => {
    const current = latestWorkspace.current;
    if (
      !next ||
      !current ||
      next.state.room.shape !== "polygon" ||
      next.state.room.id !== current.room.id
    ) {
      setConnection(null);
      return;
    }
    setConnection(next);
    if (
      next.state.room.objects.some((object) => object.productId) ||
      current.room.revision !== next.state.room.revision
    )
      setShowScan(false);
    // A mutation response can arrive before the reactive query catches up.
    if (
      current.cloudProjectId === next.projectId &&
      next.state.room.revision < current.room.revision
    )
      return;
    const updated: Workspace = {
      ...current,
      cloudProjectId: next.projectId,
      room: next.state.room,
      design: {
        products: next.state.products,
        assets: next.state.assets,
        brief: next.state.brief,
      },
    };
    latestWorkspace.current = updated;
    setWorkspace(updated);
    try {
      persistCallback.current?.(updated);
      setStatus("Saved to your account");
    } catch {
      setStatus("Saved to your account. Browser cache is unavailable.");
    }
    if (current.room.revision !== updated.room.revision) {
      setPreview(null);
      setPreviewIssue(null);
      setSuggestion(null);
      setSelected((id) =>
        updated.room.objects.some((object) => object.id === id) ? id : null,
      );
    }
  }, []);
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
    setPreview(null);
    setEditMode("select");
    setWalkChatOpen(false);
    setWalking(true);
  }

  function persist(next: Workspace | null) {
    latestWorkspace.current = next;
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
  async function execute(commands: DesignCommand[]) {
    const current = latestWorkspace.current;
    if (!current || !design) throw new Error("Import a room first.");
    if (editPending.current)
      throw new Error("Wait for the current edit to finish.");
    if (disconnected)
      throw new Error(
        "Reconnect this room's conversation before editing its saved design.",
      );
    editPending.current = true;
    setEditing(true);
    setError("");
    try {
      const next = connection
        ? await connection.execute(commands, current.room.revision)
        : applyDesignCommands(
            current.room,
            commands,
            design.products,
            design.brief,
          );
      if (next.shape !== "polygon")
        throw new Error("This editor requires a captured room.");
      const updated = {
        ...current,
        room: next,
        design: {
          products: design.products,
          assets: design.assets,
          brief: design.brief,
        },
      };
      if (connection) {
        persist(updated);
        setStatus("Saved to your account");
      } else commit(updated);
      setShowScan(false);
      setPreview(null);
      setPreviewIssue(null);
      setSuggestion(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This edit could not be applied.",
      );
      throw cause;
    } finally {
      editPending.current = false;
      setEditing(false);
    }
  }
  async function placeProduct(productId: string, zoneId?: string) {
    if (!design) throw new Error("Wait for the room design to load.");
    const product = design.products.find((item) => item.id === productId);
    if (!product)
      throw new Error("This product is no longer in the catalog. Search again.");
    const issue = productPlacementIssue(product);
    if (issue) throw new Error(issue);
    const recommendation = design.recommendations.find(
      (item) =>
        item.product.id === productId && (!zoneId || item.zone?.id === zoneId),
    );
    const zone = recommendation?.zone;
    const occupied =
      zone && design.room.objects.some((item) => item.zoneId === zone.id);
    const id = objectId();
    await execute([
      {
        type: "add",
        productId,
        instanceId: id,
        ...(zone && !occupied ? { zone } : {}),
      },
    ]);
    setSelected(id);
  }
  async function placeAll() {
    if (!design) return;
    const pending = design.recommendations.filter(
      ({ product, zone }) =>
        product.measurement.dimensions !== null &&
        !design.room.objects.some((item) =>
          zone ? item.zoneId === zone.id : item.productId === product.id,
        ),
    );
    for (const { product } of pending) {
      const issue = productPlacementIssue(product);
      if (issue) throw new Error(`${product.name}: ${issue}`);
    }
    // Hosts must exist before their tabletop accessories are constructed.
    pending.sort(
      (a, b) =>
        Number(a.zone?.mount === "surface") -
        Number(b.zone?.mount === "surface"),
    );
    await execute(
      pending.map(({ product, zone }) => ({
        type: "add",
        productId: product.id,
        instanceId: objectId(),
        ...(zone ? { zone } : {}),
      })),
    );
  }
  function placementError(object: RoomObject, correction = false) {
    if (!room || !design) return "Import a room first.";
    try {
      applyDesignCommands(
        room,
        [
          correction
            ? { type: "correct", object }
            : {
                type: "move",
                objectId: object.id,
                position: object.position,
                rotationY: object.rotation.y,
              },
        ],
        design.products,
        design.brief,
      );
      return null;
    } catch (cause) {
      return cause instanceof Error
        ? cause.message
        : "This placement is not available.";
    }
  }
  function saveObject(object: RoomObject) {
    commitPreview(object, true);
  }
  function previewObject(object: RoomObject) {
    if (!room) return;
    setPreview(object);
    setPreviewCorrection(false);
    setPreviewIssue(placementError(object));
    setSuggestion(null);
  }
  function commitPreview(object: RoomObject, correction = false) {
    if (!room) return;
    const issue = placementError(object, correction);
    setPreviewCorrection(correction);
    if (issue) {
      setPreview(object);
      setPreviewIssue(issue);
      setSuggestion(suggestPlacement(room, object));
      return;
    }
    void execute([
      correction
        ? { type: "correct", object }
        : {
            type: "move",
            objectId: object.id,
            position: object.position,
            rotationY: object.rotation.y,
          },
    ]).catch(() => undefined);
  }
  function selectObject(id: string | null) {
    setSelected(id);
    setPreview(null);
    setPreviewIssue(null);
    setSuggestion(null);
    if (id) {
      setShowScan(false);
      setProductsOpen(false);
      if (window.matchMedia("(max-width: 1023px)").matches) setChatOpen(false);
    }
  }
  function toggleProducts() {
    if (!productsOpen && window.matchMedia("(max-width: 1023px)").matches)
      setChatOpen(false);
    setProductsOpen(!productsOpen);
  }
  function askAboutSelected() {
    setProductsOpen(false);
    if (walking) setWalkChatOpen(true);
    else setChatOpen(true);
    walkInput.current.pressed.clear();
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(),
    );
  }
  function acceptReconstruction(scene: ReconstructedScene) {
    if (!resource) return;
    if (!workspace || workspace.scanId !== resource.id) return;
    const merged = mergeDiscoveredObjects(
      workspace.room,
      scene,
      workspace.reconstructionObjectIds,
    );
    if (!connection) persist({ ...workspace, ...merged });
    else {
      const discoveries = merged.room.objects.filter(
        (object) =>
          !workspace.room.objects.some((existing) => existing.id === object.id),
      );
      if (discoveries.length)
        void execute(
          discoveries.map((object) => ({ type: "discover", object })),
        )
          .then(() => {
            const current = latestWorkspace.current;
            if (current)
              persist({
                ...current,
                reconstructionObjectIds: merged.reconstructionObjectIds,
              });
          })
          .catch(() => undefined);
    }
    setCapture((current) =>
      current?.id === resource.id ? { ...current, scene } : current,
    );
    setShowSimulation(true);
    setShowScan(false);
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
  async function undo() {
    if (connection && room) {
      if (editPending.current) return;
      editPending.current = true;
      setEditing(true);
      try {
        const next = await connection.undo(room.revision);
        const current = latestWorkspace.current;
        if (current && next.shape === "polygon")
          persist({ ...current, room: next });
        setPreview(null);
        setSelected(null);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not undo this edit.",
        );
      } finally {
        editPending.current = false;
        setEditing(false);
      }
      return;
    }
    if (!history.length || disconnected) return;
    const previous = history[history.length - 1];
    persist(
      previous && room
        ? {
            ...previous,
            room: { ...previous.room, revision: room.revision + 1 },
          }
        : previous,
    );
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
  const clearChat = panelOpen ? "right-4 lg:right-[392px]" : "right-4";
  const chatDock = (
    <>
      <Button
        ref={chatLauncher}
        variant="primary"
        aria-label="Open chat"
        title="Open chat"
        aria-expanded={panelOpen}
        aria-controls={chatId}
        inert={panelOpen}
        aria-hidden={panelOpen}
        onClick={() => {
          if (walking) setWalkChatOpen(true);
          else setChatOpen(true);
          requestAnimationFrame(() => {
            root.current
              ?.querySelector<HTMLButtonElement>('[aria-label="Collapse chat"]')
              ?.focus({ preventScroll: true });
          });
        }}
        className={cx(
          "absolute top-4 right-4 z-20 size-11 !rounded-panel !p-0 shadow-lift !transition-[scale,opacity,background-color] duration-250 ease-out motion-reduce:transition-none [&>svg]:!size-5",
          panelOpen
            ? "pointer-events-none scale-75 opacity-0"
            : "scale-100 opacity-100",
        )}
      >
        <MessageCircle aria-hidden="true" strokeWidth={1.75} />
      </Button>
      <FloatingPanel
        id={chatId}
        aria-label="Design chat"
        inert={!panelOpen}
        aria-hidden={!panelOpen}
        className={cx(
          "right-4 bottom-4 flex w-[360px] max-w-[calc(100%-32px)] origin-top-right flex-col overflow-hidden !bg-chalk !p-0 transition-[scale,translate,opacity,visibility] duration-250 ease-out motion-reduce:transition-none",
          room ? "top-28 lg:top-4" : "top-4",
          panelOpen
            ? "visible scale-100 opacity-100"
            : "invisible pointer-events-none scale-90 opacity-0",
          walking &&
            !walkChatOpen &&
            "translate-x-[calc(100%+32px)] opacity-0 pointer-events-none",
        )}
      >
        {
          // eslint-disable-next-line react-hooks/refs -- chat renders the panel; onCollapse reads the launcher ref only after interaction.
          chat({
            room,
            selectedObjectId: selected,
            onDesign: acceptDesign,
            onProject: connectProject,
            onPlaceProduct: placeProduct,
            productPlacementIssues: Object.fromEntries(
              (design?.products ?? []).map((product) => [
                product.id,
                productPlacementIssue(product),
              ]),
            ),
            placedZoneIds: room?.objects.flatMap((object) =>
              object.zoneId ? [object.zoneId] : [],
            ),
            placedProductIds: room?.objects.flatMap((object) =>
              object.productId ? [object.productId] : [],
            ),
            editing: editDisabled,
            onCollapse: () => {
              if (walking) setWalkChatOpen(false);
              else setChatOpen(false);
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
                className="max-lg:grid max-lg:grid-cols-[auto_minmax(0,1fr)] [&>div:nth-child(2)]:min-w-0 [&>div:nth-child(3)]:max-lg:hidden [&>div:last-child]:max-lg:col-span-2 [&>div:last-child]:max-lg:overflow-x-auto"
                brand={brand}
                title={
                  <>
                    {title ?? room.name}
                    {room.capture.synthetic && <Pill>sample</Pill>}
                  </>
                }
              >
                {status && (
                  <Muted className="hidden text-xs 2xl:block">{status}</Muted>
                )}
                <Button
                  disabled={!design?.canUndo || editDisabled}
                  onClick={() => void undo()}
                >
                  <Undo2 /> Undo
                </Button>
                <Button aria-pressed={productsOpen} onClick={toggleProducts}>
                  <ShoppingBag /> Products
                  {design
                    ? ` · ${room.objects.some((item) => !item.owned && item.productId && !design.products.some((product) => product.id === item.productId)) ? "Unpriced items" : formatMoney(room.objects.filter((item) => !item.owned).reduce((sum, item) => sum + (design.products.find((product) => product.id === item.productId)?.priceCents ?? 0), 0))}`
                    : ""}
                </Button>
                <Button
                  aria-label="Download room"
                  title="Download room"
                  disabled={busy}
                  onClick={() => void download()}
                >
                  <Download />{" "}
                  <span className="hidden xl:inline">Download room</span>
                </Button>
                {// eslint-disable-next-line react-hooks/refs -- scan renders a control; receive runs only when a scan arrives.
                scan?.("bar", receive)}
                <Button
                  disabled={busy}
                  aria-label="Import a scan"
                  title="Import a scan"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload />
                  <span className="hidden xl:inline">
                    {busy ? "Importing…" : "Import a scan"}
                  </span>
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
                panelOpen && "lg:right-[376px]",
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
                  selected={selected}
                  onSelect={selectObject}
                  assetScenes={assets}
                  assetStates={Object.fromEntries((design?.assets ?? []).map((asset) => [asset.id, asset.status]))}
                  preview={preview}
                  previewInvalid={Boolean(previewIssue)}
                  editMode={editDisabled || walking ? "select" : editMode}
                  snap={snap}
                  onPreview={previewObject}
                  onCommit={commitPreview}
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
                  {/* The renderer registers this completion callback; it runs after reconstruction. */}
                  {/* eslint-disable-next-line react-hooks/refs */}
                  {reconstruct(resource.evidence, acceptReconstruction)}
                </div>
              )}

            <ScanDock
              hidden={walking || productsOpen}
              room={room}
              selected={selected}
              onSelect={selectObject}
              busy={editDisabled}
              products={design?.products}
              onAsk={askAboutSelected}
              onArrange={() => {
                if (selected) void execute([{ type: "arrange", objectId: selected }]).catch(() => undefined);
              }}
              onReplace={(productId) =>
                selected
                  ? execute([
                      { type: "replace", objectId: selected, productId },
                    ])
                  : Promise.resolve()
              }
              onEditMode={setEditMode}
              editMode={editMode}
              snap={snap}
              onSnap={setSnap}
              onPreview={previewObject}
              onMove={commitPreview}
              originalObject={originalObject}
              onSave={saveObject}
              onReset={(id) => {
                const source = originalObject(id);
                if (source)
                  void execute([{ type: "correct", object: source }]).catch(
                    () => undefined,
                  );
              }}
              onRemove={(id) => {
                void execute([{ type: "remove", objectId: id }])
                  .then(() => setSelected(null))
                  .catch(() => undefined);
              }}
              captureWarnings={resource?.scan?.warnings}
            />

            {productsOpen && !walking && design && (
              <DesignPanel
                state={design}
                busy={editDisabled}
                onClose={() => setProductsOpen(false)}
                onPlace={placeProduct}
                onPlaceAll={placeAll}
                onSelect={selectObject}
                onRetry={(id) =>
                  connection?.retryAsset(id) ?? Promise.resolve()
                }
              />
            )}
            {preview && previewIssue && (
              <FloatingPanel
                role="alert"
                className={`bottom-12 left-4 max-w-[380px] ${panelOpen ? "lg:left-[280px]" : "lg:left-1/3"}`}
              >
                <p className="text-sm text-rust">{previewIssue}</p>
                <div className="mt-2 flex gap-2">
                  {suggestion && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        commitPreview(suggestion, previewCorrection)
                      }
                    >
                      Use suggested placement
                    </Button>
                  )}
                  {!suggestion && (
                    <Button
                      size="sm"
                      onClick={() =>
                        setSuggestion(suggestPlacement(room, preview))
                      }
                    >
                      Find a clear spot
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setPreview(null);
                      setPreviewIssue(null);
                      setSuggestion(null);
                    }}
                  >
                    Cancel move
                  </Button>
                </div>
              </FloatingPanel>
            )}
            {walking && selected && (
              <FloatingPanel
                className={`bottom-4 w-64 ${walkChatOpen ? "hidden lg:block lg:right-[392px]" : "right-4"}`}
                aria-label="Selected item"
              >
                <div className="flex justify-between gap-2">
                  <p className="font-display text-base">
                    {room.objects.find((item) => item.id === selected)?.name}
                  </p>
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label="Deselect item"
                    onClick={() => setSelected(null)}
                  >
                    <X />
                  </Button>
                </div>
                {design && (
                  <Muted className="mt-1 block text-xs">
                    {(() => {
                      const object = room.objects.find(
                        (item) => item.id === selected,
                      );
                      const product = design.products.find(
                        (item) => item.id === object?.productId,
                      );
                      return product
                        ? `${formatMoney(product.priceCents)} · ${product.merchant}${object?.productLocked ? " · Product kept" : ""}`
                        : "Existing possession";
                    })()}
                  </Muted>
                )}
                <Button
                  size="sm"
                  className="mt-2"
                  variant="primary"
                  onClick={askAboutSelected}
                >
                  Ask Rumi about this
                </Button>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    exitWalk();
                    selectObject(selected);
                  }}
                >
                  Edit item
                </Button>
              </FloatingPanel>
            )}
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
              {disconnected && (
                <Notice>
                  Reconnect this room’s chat to edit its saved design. Your
                  cached room is still available.
                </Notice>
              )}
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
