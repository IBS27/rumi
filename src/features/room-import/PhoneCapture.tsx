import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ScanLine, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

type Pairing = FunctionReturnType<typeof api.captures.create>;
export function PhoneCapture({
  onReceive,
}: {
  onReceive: (text: string) => void;
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
  async function start() {
    dialog.current?.showModal();
    setError("");
    setBusy(true);
    setReceived(false);
    try {
      if (pairing && session?.state !== "uploaded")
        await cancel({ sessionId: pairing.sessionId });
      setPairing(null);
      const next = await create({});
      setPairing(next);
      setNow(Date.now());
    } catch {
      setError(
        "Could not connect to the capture service. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    if (pairing && session?.state !== "uploaded") {
      try {
        await cancel({ sessionId: pairing.sessionId });
      } catch {
        /* An unrevoked token still expires automatically. */
      }
    }
    dialog.current?.close();
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
      <button
        onClick={() => {
          void start();
        }}
      >
        <ScanLine size={16} /> Scan with iPhone
      </button>
      <dialog
        ref={dialog}
        className="pairing-dialog"
        onCancel={(event) => {
          event.preventDefault();
          void close();
        }}
      >
        <button
          className="dialog-close"
          disabled={busy}
          aria-label="Close phone pairing"
          onClick={() => {
            void close();
          }}
        >
          <X size={18} />
        </button>
        <div className="eyebrow">CONNECT YOUR SPACE</div>
        <h2>Bring your room to Rumi.</h2>
        {busy ? (
          <p role="status">Creating a secure connection…</p>
        ) : received ? (
          <p role="status">
            Your scan is ready. Close this window to explore your room.
          </p>
        ) : expired || unavailable ? (
          <>
            <p>
              This connection is no longer available. Your scan remains on your
              phone.
            </p>
            <button
              onClick={() => {
                void start();
              }}
            >
              Create a new QR code
            </button>
          </>
        ) : waiting ? (
          <>
            <p>
              Open the Rumi scanner on your iPhone and choose{" "}
              <strong>Connect to Rumi</strong>.
            </p>
            <div className="qr-code">
              <QRCodeSVG
                value={JSON.stringify(pairing)}
                size={240}
                marginSize={4}
                level="M"
                title="Pair your iPhone with this Rumi session"
              />
            </div>
            <p className="muted">
              Expires in {Math.max(0, Math.ceil((expiresAt - now) / 60000))}{" "}
              minutes. Keep this page open.
            </p>
          </>
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
            <p className="error" role="alert">
              {error}
            </p>
            <button
              onClick={() => {
                if (session?.fileUrl) setRetry((value) => value + 1);
                else void start();
              }}
            >
              Try again
            </button>
          </>
        )}
        <p className="small muted">
          Only this capture session is shared with your phone.
        </p>
      </dialog>
    </>
  );
}
