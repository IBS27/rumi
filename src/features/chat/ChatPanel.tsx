import { Button } from "../../ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Check,
  ExternalLink,
  History,
  LoaderCircle,
  PanelRightClose,
  Plus,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  CapturedRoom,
  ProjectPhase,
  RoomSnapshot,
} from "../../../shared/contracts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../../shared/chat/uploads";
import { Composer } from "./Composer";
import { OptionsCard } from "./OptionsCard";
import { ChatHistory } from "./ChatHistory";

export type ChatContext = { room?: CapturedRoom; onCollapse: () => void };

type Recommendation = {
  id: string;
  name: string;
  merchant: string;
  sourceUrl: string;
  imageUrl: string | null;
  priceCents: number;
};

type ActivityItem = {
  id: string;
  tool: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

function RippleDots() {
  return (
    <span className="ml-1 inline-flex items-end gap-0.5" aria-label="Streaming">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-teal motion-safe:animate-bounce"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}

function ActivityRows({ activity }: { activity: ActivityItem[] }) {
  return (
    <div className="space-y-1">
      {activity.map((item) => (
        <div key={item.id} className="flex items-start gap-1.5 text-[11px] text-mute">
          {item.status === "running" ? (
            <LoaderCircle className="mt-0.5 size-3 shrink-0 motion-safe:animate-spin" />
          ) : item.status === "done" ? (
            <Check className="mt-0.5 size-3 shrink-0 text-teal-deep" />
          ) : (
            <X className="mt-0.5 size-3 shrink-0 text-rust" />
          )}
          <span className="[overflow-wrap:anywhere]">
            {item.label}
            {item.detail ? ` — ${item.detail}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  activity,
  pending,
}: {
  activity?: ActivityItem[];
  pending: boolean;
}) {
  if (!activity?.length) return null;
  if (pending)
    return (
      <div className="mb-2 rounded-ctrl border border-line bg-panel-soft px-2.5 py-2">
        <ActivityRows activity={activity} />
      </div>
    );
  return (
    <details className="mb-1.5 text-[11px] text-mute">
      <summary className="cursor-pointer select-none hover:text-ink">
        {activity.length} agent step{activity.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-1.5 border-l border-line pl-2">
        <ActivityRows activity={activity} />
      </div>
    </details>
  );
}

function ProductCard({ product }: { product: Recommendation }) {
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(product.priceCents / 100);
  return (
    <article className="mt-2 overflow-hidden rounded-tile border border-line bg-white">
      <h4 className="px-3 pt-2.5 pb-2 text-[12px] font-medium leading-snug text-ink">
        {product.name}
      </h4>
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.name}
          className="max-h-56 w-full border-y border-line bg-panel-soft object-contain"
        />
      ) : (
        <div className="grid h-24 place-items-center border-y border-line bg-panel-soft text-[11px] text-mute">
          No product image available
        </div>
      )}
      <div className="px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-ink">{price}</span>
          <span className="truncate text-mute">{product.merchant}</span>
        </div>
        <a
          href={product.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[11px] font-medium text-teal-deep no-underline hover:text-ink"
        >
          View product
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </div>
    </article>
  );
}

const PHASES: { id: ProjectPhase; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "plan", label: "Plan" },
  { id: "review", label: "Review" },
];

function PhaseStepper({ phase }: { phase: ProjectPhase }) {
  const current = PHASES.findIndex((step) => step.id === phase);
  return (
    <ol
      className="mb-2 flex items-center gap-1.5 text-[11px]"
      aria-label="Project stage"
    >
      {PHASES.map((step, index) => (
        <li key={step.id} className="flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden className="h-px w-3 bg-line" />
          )}
          <span
            aria-current={index === current ? "step" : undefined}
            className={
              index === current
                ? "rounded-full bg-wash px-2 py-0.5 font-medium text-ink"
                : index < current
                  ? "text-ink"
                  : "text-mute"
            }
          >
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
      <h2 className="text-[11px] font-medium text-mute">Your brief</h2>
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
      className="flex h-full min-h-0 flex-col gap-2.5 px-4 pt-3.5 pb-3"
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

function sameRoom(a: RoomSnapshot | null, b?: RoomSnapshot) {
  if (!a || !b) return a === (b ?? null);
  return (
    JSON.stringify({ ...a, revision: 0 }) ===
    JSON.stringify({ ...b, revision: 0 })
  );
}

export function ChatPanel({
  room,
  onCollapse,
  identity,
}: ChatContext & { identity: string }) {
  const storageKey = `rumi.chat.v1.${identity}`;
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
      className="flex h-full min-h-0 flex-col gap-2.5 px-4 pt-3.5 pb-3"
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
      {attachmentError && (
        <p
          className="shrink-0 text-xs text-rust [overflow-wrap:anywhere]"
          role="alert"
        >
          {attachmentError}
        </p>
      )}
      {history ? (
        <ChatHistory
          activeId={activeId}
          onSelect={select}
          onClose={() => setHistory(false)}
        />
      ) : activeId ? (
        <Conversation
          key={activeId}
          projectId={activeId}
          room={room}
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
          <Composer
            onSend={async (text) => {
              const id = await create({
                title: text.slice(0, 80),
                room,
                firstMessage: text,
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
}: {
  projectId: Id<"projects">;
  room?: CapturedRoom;
  upload: (id: Id<"projects">, file: File) => Promise<void>;
  onNew: () => void;
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
  const needsUpdate = Boolean(room && !sameRoom(context.room, room));
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
        <PhaseStepper phase={context.phase} />
        <h3 className="mb-2 font-display text-sm font-medium leading-snug [overflow-wrap:anywhere]">
          {context.brief.prompt || context.project.title}
        </h3>
        <div className="flex items-center gap-1.5 text-xs text-mute [&>svg]:shrink-0 [overflow-wrap:anywhere]">
          <ScanLine size={14} />
          <span>{context.room?.name ?? "No room attached yet"}</span>
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
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain py-0.5 text-[12.5px]"
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
          if (message.status === "pending")
            return (
              <div
                key={message._id}
                className="shrink-0 leading-relaxed text-ink [overflow-wrap:anywhere]"
                role="status"
              >
                <span className="mb-1.5 block text-[11px] font-medium text-teal-deep">
                  Rumi
                </span>
                <ActivityFeed activity={message.activity} pending />
                {message.content ? (
                  <p className="whitespace-pre-wrap">
                    {message.content}
                    <RippleDots />
                  </p>
                ) : !message.activity?.length ? (
                  <p className="text-xs text-mute">
                    Thinking
                    <RippleDots />
                  </p>
                ) : null}
                {message.recommendation && (
                  <ProductCard product={message.recommendation} />
                )}
              </div>
            );
          if (!message.content && !message.imageUrl && !message.recommendation)
            return null;
          return (
            <div
              key={message._id}
              className={`shrink-0 leading-relaxed [overflow-wrap:anywhere] ${message.role === "user" ? "border-l-2 border-blue pl-3 text-mute" : "text-ink"}`}
            >
              {message.role === "assistant" && (
                <span className="mb-0.5 block text-[11px] font-medium text-teal-deep">
                  Rumi
                </span>
              )}
              {message.role === "assistant" && (
                <ActivityFeed activity={message.activity} pending={false} />
              )}
              {message.imageUrl && (
                <a href={message.imageUrl} target="_blank" rel="noreferrer">
                  <img
                    className="mb-1.5 max-h-56 w-full rounded-ctrl object-contain"
                    src={message.imageUrl}
                    alt="Your inspiration image"
                  />
                </a>
              )}
              <p
                className={`whitespace-pre-wrap ${message.status === "error" ? "text-rust" : ""}`}
              >
                {message.imageUrl ? "Inspiration image" : message.content}
              </p>
              {message.recommendation && (
                <ProductCard product={message.recommendation} />
              )}
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
            </div>
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
      <Composer
        disabled={pending || updating}
        placeholder={pending ? "Rumi is thinking…" : "Tell Rumi what to change"}
        onSend={async (content) => {
          await prepare();
          await send({ projectId, content });
        }}
        onUpload={async (file) => {
          await prepare();
          await upload(projectId, file);
        }}
      />
    </>
  );
}
