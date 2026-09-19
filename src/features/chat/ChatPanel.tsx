import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  History,
  MessageCircle,
  PanelRightClose,
  Plus,
  RotateCcw,
  ScanLine,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { CapturedRoom, RoomSnapshot } from "../../../shared/contracts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../../shared/chat/uploads";
import { Composer } from "./Composer";
import { OptionsCard } from "./OptionsCard";
import { ChatHistory } from "./ChatHistory";

export type ChatContext = { room?: CapturedRoom; onCollapse: () => void };

function ChatHeader({
  onCollapse,
  children,
}: {
  onCollapse: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="chat-header">
      <div>
        <MessageCircle size={18} />
        <h2>Design with Rumi</h2>
      </div>
      <div className="chat-header-actions">
        {children}
        <button
          className="icon-button"
          aria-label="Collapse chat"
          title="Collapse chat"
          onClick={onCollapse}
        >
          <PanelRightClose size={17} />
        </button>
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
    <section className="chat-panel" aria-label="Design chat">
      <ChatHeader onCollapse={onCollapse} />
      <div className="chat-welcome">
        <span className="chat-mark">
          <MessageCircle size={24} />
        </span>
        <h3>A room that feels like you.</h3>
        <p>
          Find your style, set a budget, and share inspiration. We’ll work
          through your room together.
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
    <section className="chat-panel" aria-label="Design chat">
      <ChatHeader onCollapse={onCollapse}>
        <button
          className="icon-button"
          aria-label="Chat history"
          title="Chat history"
          aria-pressed={history}
          onClick={() => setHistory((value) => !value)}
        >
          <History size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="New chat"
          title="New chat"
          onClick={() => select(null)}
        >
          <Plus size={18} />
        </button>
      </ChatHeader>
      {attachmentError && (
        <p className="chat-error chat-panel-error" role="alert">
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
          <div className="chat-welcome">
            <span className="chat-mark">
              <MessageCircle size={24} />
            </span>
            <h3>A room that feels like you.</h3>
            <p>
              Tell me what you’d like to change. We can start with a feeling, a
              budget, or an inspiration image.
            </p>
            <div className="chat-room-label">
              <ScanLine size={15} />
              {room ? room.name : "No room scan needed to start"}
            </div>
            {room?.capture.synthetic && (
              <small className="muted">Using the synthetic sample room.</small>
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
  useEffect(() => {
    const area = scroll.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [newestId, pending]);
  if (context === null)
    return (
      <div className="chat-welcome">
        <p>This conversation is no longer available.</p>
        <button onClick={onNew}>Start a new conversation</button>
      </div>
    );
  if (!context || status === "LoadingFirstPage")
    return (
      <div className="chat-welcome" role="status">
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
      <div className="chat-context">
        <h3>{context.project.title}</h3>
        <div className="chat-room-label">
          <ScanLine size={14} />
          <span>{context.room?.name ?? "No room attached yet"}</span>
        </div>
        {needsUpdate && (
          <button
            className="text-button"
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
          </button>
        )}
        {(context.brief.budgetCents > 0 || context.brief.styles.length > 0) && (
          <p className="chat-brief">
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
            {context.brief.styles.map((style) => (
              <span key={style}>{style}</span>
            ))}
          </p>
        )}
      </div>
      <div
        className="chat-transcript"
        ref={scroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {status === "CanLoadMore" && (
          <button className="text-button" onClick={() => loadMore(30)}>
            Load earlier messages
          </button>
        )}
        {status === "LoadingMore" && (
          <p className="muted">Loading earlier messages…</p>
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
              <div key={message._id} className="chat-thinking" role="status">
                <span />
                Rumi is thinking…
              </div>
            );
          if (!message.content && !message.imageUrl) return null;
          return (
            <div
              key={message._id}
              className={`chat-message ${message.role === "user" ? "from-user" : "from-rumi"}`}
            >
              {message.role === "assistant" && (
                <span className="message-author">rumi</span>
              )}
              {message.imageUrl && (
                <a href={message.imageUrl} target="_blank" rel="noreferrer">
                  <img src={message.imageUrl} alt="Your inspiration image" />
                </a>
              )}
              <p
                className={
                  message.status === "error" ? "chat-error" : undefined
                }
              >
                {message.imageUrl ? "Inspiration image" : message.content}
              </p>
              {message.status === "error" && message._id === newestId && (
                <button
                  className="text-button"
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
                </button>
              )}
            </div>
          );
        })}
        {!results.length && (
          <p className="muted">
            Start with what you’d like to change about your room.
          </p>
        )}
      </div>
      {error && (
        <p className="chat-error chat-panel-error" role="alert">
          {error}
        </p>
      )}
      <Composer
        disabled={pending || updating}
        placeholder={
          pending ? "Rumi is thinking…" : "Ask for changes, or set a budget…"
        }
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
