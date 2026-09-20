import { Button } from "../../ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  History,
  PanelRightClose,
  Plus,
  RotateCcw,
  ScanLine,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { CapturedRoom, ProjectPhase } from "../../../shared/contracts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../../shared/chat/uploads";
import { ChatMessage } from "./ChatMessage";
import { Composer } from "./Composer";
import { OptionsCard } from "./OptionsCard";
import { PlanCard } from "./PlanCard";
import { DesignConnection } from "./DesignConnection";
import { DesignSyncBoundary } from "./DesignSyncBoundary";
import type { DesignConnection as Connection } from "../room-editor/designConnection";
import { ChatHistory } from "./ChatHistory";
import { chatKey } from "../workspace/sessions";

/** `sessionId` scopes the open conversation to the current session. */
export type ChatContext = {
  room?: CapturedRoom;
  sessionId?: string;
  onCollapse: () => void;
  selectedObjectId?: string | null;
  onDesign?: (connection: Connection | null) => void;
  onProject?: (projectId: string) => void;
  onPlaceProduct?: (productId: string, zoneId?: string) => Promise<void>;
  productPlacementIssues?: Record<string, string | null>;
  placedProductIds?: string[];
  placedZoneIds?: string[];
  editing?: boolean;
  placementDisabled?: boolean;
};

const PHASES: { id: ProjectPhase; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
];

// Always visible under the panel header. A new chat starts in Spec.
function PhaseStepper({ phase }: { phase: ProjectPhase }) {
  const current = PHASES.findIndex((step) => step.id === phase);
  return (
    <ol
      className="flex shrink-0 items-center gap-2 text-xs"
      aria-label="Project stage"
    >
      {PHASES.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden className="h-px w-4 bg-line-strong" />
          )}
          <span
            aria-current={index === current ? "step" : undefined}
            className={`flex items-center gap-1.5 ${
              index === current
                ? "rounded-full bg-teal px-2.5 py-0.5 font-medium text-white"
                : index < current
                  ? "text-teal-deep"
                  : "text-mute"
            }`}
          >
            <span
              aria-hidden
              className={`grid size-4 place-items-center rounded-full text-[10px] ${
                index === current
                  ? "bg-white/25"
                  : index < current
                    ? "bg-teal-tint text-teal-deep"
                    : "bg-wash"
              }`}
            >
              {index + 1}
            </span>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ChatHeader({
  onCollapse,
  children,
}: {
  onCollapse: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h2 className="font-display text-base font-medium text-ink">Rumi</h2>
      <div className="flex items-center gap-0.5">
        {children}
        <Button
          size="sm"
          variant="quiet"
          className="size-7 shrink-0 p-1 text-mute"
          aria-label="Collapse chat"
          title="Collapse chat"
          onClick={onCollapse}
        >
          <PanelRightClose size={17} />
        </Button>
      </div>
    </div>
  );
}

export function ChatUnavailable({
  onCollapse,
  signIn,
  connecting = false,
}: Pick<ChatContext, "onCollapse"> & {
  signIn?: ReactNode;
  connecting?: boolean;
}) {
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3 px-4 pt-4 pb-3"
      aria-label="Design chat"
    >
      <ChatHeader onCollapse={onCollapse} />
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto pt-2 text-[12.5px] leading-relaxed">
        <h3 className="font-display text-sm font-medium leading-snug">
          What would you like to change?
        </h3>
        <p>
          Tell Rumi about your room, your budget, or an idea you want to try.
        </p>
        {connecting ? (
          <p role="status">Connecting to your conversations…</p>
        ) : signIn ? (
          <>
            <p>Sign in to start a conversation and keep your ideas together.</p>
            {signIn}
          </>
        ) : (
          <p>Chat is not available in this preview yet.</p>
        )}
      </div>
    </section>
  );
}

export function ChatPanel({
  room,
  sessionId,
  onCollapse,
  identity,
  selectedObjectId,
  onDesign,
  onProject,
  onPlaceProduct,
  productPlacementIssues,
  placedProductIds,
  placedZoneIds,
  editing,
  placementDisabled,
}: ChatContext & { identity: string }) {
  const storageKey = sessionId
    ? chatKey(identity, sessionId)
    : `rumi.chat.v1.${identity}`;
  const [activeId, setActiveId] = useState<Id<"projects"> | null>(() => {
    try {
      const id = localStorage.getItem(storageKey);
      return id && /^[a-z0-9]{32}$/.test(id) ? (id as Id<"projects">) : null;
    } catch {
      return null;
    }
  });
  const [history, setHistory] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const active = useQuery(
    api.projects.context,
    activeId ? { projectId: activeId } : "skip",
  );
  const phase: ProjectPhase = active?.phase ?? "spec";
  useEffect(() => {
    if (activeId && room && active?.room?.id === room.id) onProject?.(activeId);
  }, [activeId, active?.room?.id, room, onProject]);
  const create = useMutation(api.projects.create);
  const beginUpload = useMutation(api.images.beginUpload);
  function select(id: Id<"projects"> | null) {
    setActiveId(id);
    setHistory(false);
    setAttachmentError("");
    try {
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    } catch {
      /* The server still keeps chat history. */
    }
  }
  async function upload(projectId: Id<"projects">, file: File) {
    setAttachmentError("");
    try {
      if (
        !IMAGE_TYPES.includes(file.type) ||
        file.size > MAX_IMAGE_BYTES ||
        !file.size
      )
        throw new Error(
          "Choose a JPEG, PNG, WebP, or GIF image of 10 MB or less.",
        );
      const authorization = await beginUpload({
        projectId,
        contentType: file.type,
        size: file.size,
      });
      const response = await fetch(authorization.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorization.token}`,
          "Content-Type": file.type,
        },
        body: file,
      });
      if (!response.ok)
        throw new Error("The image could not be attached. Please try again.");
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The image could not be attached. Please try again.";
      setAttachmentError(message);
      throw new Error(message, { cause });
    }
  }
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3 px-4 pt-4 pb-3"
      aria-label="Design chat"
    >
      <ChatHeader onCollapse={onCollapse}>
        <Button
          size="sm"
          variant="quiet"
          className="size-7 shrink-0 p-1 text-mute"
          aria-label="Chat history"
          title="Chat history"
          aria-pressed={history}
          onClick={() => setHistory((value) => !value)}
        >
          <History size={17} />
        </Button>
        <Button
          size="sm"
          variant="quiet"
          className="size-7 shrink-0 p-1 text-mute"
          aria-label="New chat"
          title="New chat"
          onClick={() => select(null)}
        >
          <Plus size={18} />
        </Button>
      </ChatHeader>
      <PhaseStepper phase={phase} />
      {activeId && onDesign && (
        <DesignSyncBoundary
          key={`sync-${activeId}`}
          onDisconnect={() => onDesign(null)}
        >
          <DesignConnection projectId={activeId} onChange={onDesign} />
        </DesignSyncBoundary>
      )}
      {attachmentError && (
        <p
          className="shrink-0 text-xs text-rust [overflow-wrap:anywhere]"
          role="alert"
        >
          {attachmentError}
        </p>
      )}
      {history && <ChatHistory activeId={activeId} onSelect={select} />}
      {activeId ? (
        <Conversation
          key={activeId}
          projectId={activeId}
          room={room}
          selectedObjectId={selectedObjectId}
          onPlaceProduct={onPlaceProduct}
          productPlacementIssues={productPlacementIssues}
          placedProductIds={placedProductIds}
          placedZoneIds={placedZoneIds}
          editing={editing}
          placementDisabled={placementDisabled}
          upload={upload}
          onNew={() => select(null)}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto pt-2 text-[12.5px] leading-relaxed">
            <h3 className="font-display text-sm font-medium leading-snug">
              What would you like to change?
            </h3>
            <p>
              Tell me what you’d like to change. We can start with a feeling, a
              budget, or an inspiration image.
            </p>
            <div className="flex items-center gap-1.5 text-xs text-mute [&>svg]:shrink-0 [overflow-wrap:anywhere]">
              <ScanLine size={15} />
              {room ? room.name : "No room scan needed to start"}
            </div>
            {room?.capture.synthetic && (
              <small className="text-mute">
                Using the synthetic sample room.
              </small>
            )}
          </div>
          {selectedObjectId &&
            room?.objects.some((object) => object.id === selectedObjectId) && (
              <p className="text-xs text-teal-deep">
                About{" "}
                {
                  room.objects.find((object) => object.id === selectedObjectId)
                    ?.name
                }
                . Ask to move, keep or replace it.
              </p>
            )}
          <Composer
            disabled={editing}
            onSend={async (text) => {
              const id = await create({
                title: text.slice(0, 80),
                room,
                firstMessage: text,
                selectedObjectId: selectedObjectId ?? undefined,
              });
              select(id);
            }}
            onUpload={async (file) => {
              if (
                !IMAGE_TYPES.includes(file.type) ||
                file.size > MAX_IMAGE_BYTES ||
                !file.size
              )
                throw new Error("Choose an image of 10 MB or less.");
              const id = await create({
                title: "Inspiration for my room",
                room,
              });
              select(id);
              await upload(id, file);
            }}
          />
        </>
      )}
    </section>
  );
}

function Conversation({
  projectId,
  room,
  upload,
  onNew,
  selectedObjectId,
  onPlaceProduct,
  productPlacementIssues,
  placedProductIds,
  placedZoneIds,
  editing,
  placementDisabled,
}: {
  projectId: Id<"projects">;
  room?: CapturedRoom;
  upload: (id: Id<"projects">, file: File) => Promise<void>;
  onNew: () => void;
  selectedObjectId?: string | null;
  onPlaceProduct?: (productId: string, zoneId?: string) => Promise<void>;
  productPlacementIssues?: Record<string, string | null>;
  placedProductIds?: string[];
  placedZoneIds?: string[];
  editing?: boolean;
  placementDisabled?: boolean;
}) {
  const context = useQuery(api.projects.context, { projectId });
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    { projectId },
    { initialNumItems: 30 },
  );
  const send = useMutation(api.messages.send);
  const retry = useMutation(api.messages.retry);
  const attach = useMutation(api.projects.attachRoom);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const newestId = results[0]?._id;
  const pending = Boolean(context?.project.activeMessageId);
  const liveProgress = results[0]
    ? `${results[0].content.length}:${results[0].activity?.length ?? 0}`
    : "";
  useEffect(() => {
    const area = scroll.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [newestId, pending, liveProgress]);
  if (context === null)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto pt-2 text-[12.5px] leading-relaxed">
        <p>This conversation is no longer available.</p>
        <Button size="sm" onClick={onNew}>
          Start a new conversation
        </Button>
      </div>
    );
  if (!context || status === "LoadingFirstPage")
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto pt-2 text-[12.5px] leading-relaxed"
        role="status"
      >
        Loading your conversation…
      </div>
    );
  const currentContext = context;
  const needsUpdate = Boolean(room && room.id !== context.room?.id);
  const differentRoom = context.room && room && context.room.id !== room.id;
  async function attachCurrent() {
    if (!room) return;
    await attach({
      projectId,
      room,
      expectedRevision: currentContext.room?.revision ?? null,
    });
  }
  async function prepare() {
    if (needsUpdate && !differentRoom) await attachCurrent();
  }
  return (
    <>
      <div className="max-h-[35%] shrink-0 overflow-y-auto border-b border-line pb-2.5">
        <h3 className="mb-2 font-display text-sm font-medium leading-snug [overflow-wrap:anywhere]">
          {context.brief.prompt || context.project.title}
        </h3>
        <div className="flex items-center gap-1.5 text-xs text-mute [&>svg]:shrink-0 [overflow-wrap:anywhere]">
          <ScanLine size={14} />
          <span className="truncate" title={context.room?.name}>
            {context.room?.name ?? "No room attached yet"}
          </span>
        </div>
        {needsUpdate && (
          <Button
            size="sm"
            variant="quiet"
            className="justify-start whitespace-normal px-0 text-left"
            disabled={pending || updating}
            onClick={async () => {
              setUpdating(true);
              setError("");
              try {
                await attachCurrent();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not attach this room.",
                );
              } finally {
                setUpdating(false);
              }
            }}
          >
            {differentRoom
              ? "Use the room on screen"
              : context.room
                ? "Update room measurements"
                : "Attach current room"}
          </Button>
        )}
        {context.brief.wants.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-1 text-xs">
            {context.brief.wants.map((want) => (
              <span
                key={want.category}
                className="rounded-full border border-line px-2 py-0.5"
                title={want.notes || undefined}
              >
                {want.category}
              </span>
            ))}
          </p>
        )}
        {(context.brief.budgetCents > 0 ||
          context.brief.styles.length > 0 ||
          context.brief.restrictions.length > 0) && (
          <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-xs text-mute">
            {context.brief.budgetCents > 0 && (
              <span>
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 0,
                }).format(context.brief.budgetCents / 100)}{" "}
                budget
              </span>
            )}
            {[
              ...new Set([
                ...context.brief.styles,
                ...context.brief.restrictions,
              ]),
            ].map((style) => (
              <span key={style}>{style}</span>
            ))}
          </p>
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain py-2 pr-1 text-[13px]"
        ref={scroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {status === "CanLoadMore" && (
          <Button
            size="sm"
            variant="quiet"
            className="justify-start whitespace-normal px-0 text-left"
            onClick={() => loadMore(30)}
          >
            Load earlier messages
          </Button>
        )}
        {status === "LoadingMore" && (
          <p className="text-mute">Loading earlier messages…</p>
        )}
        {[...results].reverse().map((message) => {
          if (message.kind === "question")
            return (
              <OptionsCard
                key={message._id}
                message={message}
                disabled={pending || updating}
                prepare={prepare}
              />
            );
          if (message.kind === "plan" && message.plan)
            return (
              <PlanCard
                key={message._id}
                message={message}
                plan={message.plan}
                disabled={pending || updating}
                prepare={prepare}
              />
            );
          if (
            !message.content &&
            !message.imageUrl &&
            !message.recommendation &&
            message.zoneCards.length === 0 &&
            message.status !== "pending"
          )
            return null;
          return (
            <ChatMessage
              key={message._id}
              message={message}
              onPlaceProduct={onPlaceProduct}
              productPlacementIssues={productPlacementIssues}
              placedProductIds={placedProductIds}
              placedZoneIds={placedZoneIds}
              editing={placementDisabled ?? editing}
            >
              {message.status === "error" && message._id === newestId && (
                <Button
                  size="sm"
                  variant="quiet"
                  className="justify-start whitespace-normal px-0 text-left"
                  disabled={pending}
                  onClick={async () => {
                    setError("");
                    try {
                      await retry({ messageId: message._id });
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not retry this reply.",
                      );
                    }
                  }}
                >
                  <RotateCcw size={13} /> Retry reply
                </Button>
              )}
            </ChatMessage>
          );
        })}
        {!results.length && (
          <p className="text-mute">
            Start with what you’d like to change about your room.
          </p>
        )}
      </div>
      {error && (
        <p
          className="shrink-0 text-xs text-rust [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      )}
      {selectedObjectId &&
        room?.objects.some((object) => object.id === selectedObjectId) && (
          <p className="rounded-ctrl bg-teal-tint px-2.5 py-2 text-xs text-teal-deep">
            About{" "}
            {
              room.objects.find((object) => object.id === selectedObjectId)
                ?.name
            }
            . Ask to move, keep or replace it.
          </p>
        )}
      <Composer
        disabled={pending || updating || editing}
        placeholder={pending ? "Rumi is thinking…" : "Tell Rumi what to change"}
        onSend={async (content) => {
          await prepare();
          await send({
            projectId,
            content,
            selectedObjectId:
              context.room?.id === room?.id
                ? (selectedObjectId ?? undefined)
                : undefined,
          });
        }}
        onUpload={async (file) => {
          await prepare();
          await upload(projectId, file);
        }}
      />
    </>
  );
}
