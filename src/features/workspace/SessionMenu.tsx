import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, ScanLine, Trash2 } from "lucide-react";
import { Brand, Button, FloatingPanel, Muted, Pill, cx } from "../../ui";
import { sessionTitle, type Session } from "./sessions";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/**
 * The wordmark as a button. Hover, focus or click opens the list of sessions,
 * newest first, with "New chat" at the top.
 */
export function SessionMenu({
  sessions,
  activeId,
  onNew,
  onSelect,
  onRemove,
}: {
  sessions: Session[];
  activeId: string;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  function show() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function hide(delay = 160) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setConfirming(null);
    }, delay);
  }
  useEffect(
    () => () => void (closeTimer.current && clearTimeout(closeTimer.current)),
    [],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const active = sessions.find((session) => session.id === activeId);
  return (
    <div
      ref={root}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={() => hide()}
      onFocus={show}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null))
          hide(0);
      }}
    >
      <Button
        variant="quiet"
        className="-mx-2 gap-1 px-2 py-1"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your sessions"
        onClick={() => (open ? hide(0) : show())}
      >
        <Brand />
        <ChevronDown
          className={cx("text-mute transition-transform", open && "rotate-180")}
        />
      </Button>
      {open && (
        <FloatingPanel
          role="menu"
          aria-label="Sessions"
          className="!fixed top-[50px] left-3 flex w-[300px] max-h-[calc(100dvh-64px)] flex-col gap-1 overflow-y-auto !p-2 text-[13px]"
        >
          <Button
            role="menuitem"
            variant="quiet"
            className="w-full justify-start"
            onClick={() => {
              onNew();
              hide(0);
            }}
          >
            <Plus /> New chat
          </Button>
          <Muted className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide">
            Sessions
          </Muted>
          {sessions.map((session) => {
            const current = session.id === activeId;
            const room = session.workspace?.room;
            return (
              <div key={session.id} className="group min-w-0">
                {
                  <div
                    className={cx(
                      "flex items-center gap-0.5 rounded-ctrl",
                      current && "bg-teal-tint",
                    )}
                  >
                    <Button
                      role="menuitem"
                      variant="quiet"
                      aria-current={current ? "true" : undefined}
                      className="min-w-0 flex-1 flex-col items-start gap-0.5 py-1.5 text-left font-normal"
                      onClick={() => {
                        onSelect(session.id);
                        hide(0);
                      }}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">
                          {sessionTitle(session)}
                        </span>
                        {room?.capture.synthetic && <Pill>sample</Pill>}
                      </span>
                      <Muted className="flex items-center gap-1 text-[11px] [&>svg]:size-3">
                        <ScanLine />
                        {room
                          ? `${room.objects.length} objects · ${dateFormat.format(session.updatedAt)}`
                          : "No room yet"}
                      </Muted>
                    </Button>
                    {(sessions.length > 1 || session.workspace) && (
                      <Button
                        size="sm"
                        variant="quiet"
                        className="size-7 shrink-0 p-1 text-mute [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${sessionTitle(session)}`}
                        onClick={() => setConfirming(session.id)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                }
                {confirming === session.id && (
                  <div
                    role="group"
                    aria-label="Confirm session deletion"
                    className="mx-1 my-1 rounded-ctrl bg-stone p-2.5 text-xs [&>button]:mt-2 [&>button]:mr-1"
                  >
                    <p>
                      Delete this session and its room from this browser? Chat
                      history stays on your account.
                    </p>
                    <Button size="sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        onRemove(session.id);
                        setConfirming(null);
                      }}
                    >
                      Delete session
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {active && !active.workspace && sessions.length === 1 && (
            <Muted className="px-3 pt-1 pb-2 text-xs">
              Bring in a room to start your first session.
            </Muted>
          )}
        </FloatingPanel>
      )}
    </div>
  );
}
