import { useAction, useMutation, useQuery } from "convex/react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Button, Dialog, Heading, Muted } from "../../ui";

type Pairing = FunctionReturnType<typeof api.captures.create>;

function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Pairs an iPhone with this session and hands back the uploaded room text.
 * `children` renders the trigger and receives `open`.
 */
export function PhoneCapture({
  onReceive,
  children,
}: {
  onReceive: (text: string) => void;
  children: (open: () => void, busy: boolean) => ReactNode;
}) {
  const create = useAction(api.captures.create);
  const cancel = useMutation(api.captures.cancel);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  const dialog = useRef<HTMLDialogElement>(null);
  const changingSession = useRef(false);
  const session = useQuery(
    api.captures.get,
    pairing ? { sessionId: pairing.sessionId } : "skip",
  );
  const receive = useEffectEvent(onReceive);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  useEffect(() => {
    if (!session?.fileUrl) return;
    const abort = new AbortController();
    void fetch(session.fileUrl, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The uploaded room could not be downloaded.");
        const text = await response.text();
        if (!abort.signal.aborted) {
          receive(text);
          setReceived(true);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load the room.",
          );
      });
    return () => abort.abort();
  }, [session?.fileUrl, retry]);
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (isOpen && !node.open) node.showModal();
    if (!isOpen && node.open) node.close();
  }, [isOpen]);
  async function start() {
    if (changingSession.current) return;
    setIsOpen(true);
    // Reopening an accepted scan must preserve its download or retry state.
    if (session?.state === "uploaded" && !received) return;
    changingSession.current = true;
    setError("");
    setBusy(true);
    setReceived(false);
    try {
      if (pairing && session?.state !== "uploaded")
        await cancel({ sessionId: pairing.sessionId });
      setPairing(null);
      setPairing(await create({}));
    } catch {
      setError(
        "Could not connect to the capture service. Check your connection and try again.",
      );
    } finally {
      changingSession.current = false;
      setBusy(false);
    }
  }
  /** Opens the dialog and starts a fresh pairing session. Safe to pass around. */
  const open = () => {
    void start();
  };
  async function close() {
    if (changingSession.current) return;
    changingSession.current = true;
    setBusy(true);
    try {
      if (pairing && session?.state !== "uploaded") {
        try {
          await cancel({ sessionId: pairing.sessionId });
        } catch {
          /* An unrevoked token still expires automatically. */
        }
      }
      setIsOpen(false);
      // Keep watching until delivery succeeds: closing may race an upload that
      // the subscription has not reported yet. Cancel preserves accepted rooms.
      if (received) {
        setPairing(null);
        setError("");
      }
    } finally {
      changingSession.current = false;
      setBusy(false);
    }
  }

  const expiresAt =
    session?.expiresAt ?? (pairing ? Date.parse(pairing.expiresAt) : 0);
  const expired = pairing && now >= expiresAt && session?.state !== "uploaded";
  const unavailable =
    pairing && (session === null || session?.state === "canceled");
  const waiting = pairing && session?.state === "waiting" && !expired;
  return (
    <>
      {/* The render prop attaches open to a click handler; it does not call it. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      {children(open, busy)}
      <Dialog
        ref={dialog}
        aria-label="Pair your iPhone"
        onClose={() => {
          if (isOpen) void close();
        }}
        closeDisabled={busy}
        onCancel={(event) => {
          event.preventDefault();
          void close();
        }}
      >
        <div className="grid gap-3">
          <Heading className="text-[20px]">Pair your iPhone</Heading>
          {busy ? (
            <p role="status">Creating a secure connection…</p>
          ) : received ? (
            <p role="status">
              Your scan is ready. Close this window to review your room.
            </p>
          ) : expired || unavailable ? (
            <>
              <p>
                This code is no longer valid. Your scan stays on your phone.
              </p>
              <Button onClick={open} className="justify-self-start">
                Show a new code
              </Button>
            </>
          ) : waiting ? (
            <div className="grid justify-items-center gap-4 rounded-tile bg-blue p-4">
              <div className="w-full max-w-64 rounded-tile bg-white p-3">
                <QRCodeSVG
                  value={JSON.stringify(pairing)}
                  size={256}
                  marginSize={4}
                  level="M"
                  className="block h-auto w-full"
                  title="Pair your iPhone with this Rumi session"
                />
              </div>
              <div className="text-ink">
                <p>
                  Open <strong>Rumi Capture</strong> on your iPhone, tap{" "}
                  <strong>Connect to Rumi</strong>, and scan this code. Confirm
                  the connection, then scan your room.
                </p>
                <p className="mt-2 text-xs text-mute">
                  Code expires in{" "}
                  <b className="font-semibold text-ink tabular-nums">
                    {countdown(expiresAt - now)}
                  </b>
                </p>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={open}
                  className="mt-2 -ml-2.5"
                >
                  Show a new code
                </Button>
              </div>
            </div>
          ) : pairing ? (
            <p role="status">
              {session?.state === "uploaded"
                ? "Loading your room…"
                : session === undefined
                  ? "Connecting…"
                  : "Phone connected. Finish Scan on your iPhone, review the room, then tap Send to Rumi. Keep this window open."}
            </p>
          ) : null}
          {error && (
            <>
              <p className="text-rust" role="alert">
                {error}
              </p>
              <Button
                className="justify-self-start"
                onClick={() => {
                  if (session?.fileUrl) setRetry((value) => value + 1);
                  else open();
                }}
              >
                Try again
              </Button>
            </>
          )}
          <Muted className="text-xs">
            Requires Rumi Capture on a LiDAR-equipped iPhone. Only this capture
            session is shared with your phone.
          </Muted>
        </div>
      </Dialog>
    </>
  );
}
