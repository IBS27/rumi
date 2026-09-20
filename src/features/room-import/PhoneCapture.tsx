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
    setIsOpen(true);
    // Reopening an accepted scan must preserve its download or retry state.
    if (session?.state === "uploaded" && !received) return;
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
      setBusy(false);
    }
  }
  /** Opens the dialog and starts a fresh pairing session. Safe to pass around. */
  const open = () => {
    void start();
  };
  async function close() {
    if (busy) return;
    if (pairing && session?.state !== "uploaded") {
      try {
        await cancel({ sessionId: pairing.sessionId });
      } catch {
        /* An unrevoked token still expires automatically. */
      }
    }
    setIsOpen(false);
    // The accepted upload still belongs to this workspace after dismissal.
    // Keep its query alive until delivery succeeds, including on retry.
    if (session?.state === "uploaded" && !received) return;
    setPairing(null);
    setError("");
  }
  const expiresAt =
    session?.expiresAt ?? (pairing ? Date.parse(pairing.expiresAt) : 0);
  const expired = pairing && now >= expiresAt && session?.state !== "uploaded";
  const unavailable =
    pairing && (session === null || session?.state === "canceled");
  const waiting = pairing && session?.state === "waiting" && !expired;
  return (
    <>
      {children(open, busy)}
      <Dialog
        ref={dialog}
        onClose={() => {
          void close();
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
            <div className="grid grid-cols-[164px_1fr] items-center gap-4 rounded-[14px] bg-blue p-4">
              <div className="rounded-tile bg-white p-2.5">
                <QRCodeSVG
                  value={JSON.stringify(pairing)}
                  size={144}
                  marginSize={0}
                  level="M"
                  className="block h-auto w-full"
                  title="Pair your iPhone with this Rumi session"
                />
              </div>
              <div className="text-[#34424d]">
                <p>
                  Open Rumi on your iPhone and scan this code, then choose{" "}
                  <strong>Connect to Rumi</strong>.
                </p>
                <p className="mt-2 text-xs text-[#5b6a75]">
                  Code expires in{" "}
                  <b className="font-semibold text-[#2e4656] tabular-nums">
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
                  : "Phone connected. Finish your scan and tap Send to Rumi."}
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
            Only this capture session is shared with your phone.
          </Muted>
        </div>
      </Dialog>
    </>
  );
}
