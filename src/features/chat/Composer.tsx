import { useRef, useState } from "react";
import { ArrowUp, ImagePlus } from "lucide-react";

export function Composer({
  onSend,
  onUpload,
  disabled = false,
  placeholder = "Tell me what you have in mind…",
}: {
  onSend: (text: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  async function submit() {
    const text = value.trim();
    if (!text || busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await onSend(text);
      setValue("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send your message. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="composer-wrap">
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label="Message Rumi"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled || busy}
          maxLength={16000}
          placeholder={placeholder}
          rows={3}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          <input
            ref={file}
            type="file"
            className="sr-only"
            aria-label="Inspiration image"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={async (event) => {
              const image = event.target.files?.[0];
              event.target.value = "";
              if (!image || disabled || busy) return;
              setBusy(true);
              setError("");
              try {
                await onUpload(image);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not upload this image.",
                );
              } finally {
                setBusy(false);
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Attach inspiration image"
            title="Attach an inspiration image"
            disabled={disabled || busy}
            onClick={() => file.current?.click()}
          >
            <ImagePlus size={18} />
          </button>
          <span className="composer-hint">
            {busy ? "Sending…" : "Shift + Enter for a new line"}
          </span>
          <button
            className="primary send-button"
            aria-label="Send message"
            disabled={disabled || busy || !value.trim()}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </div>
  );
}
