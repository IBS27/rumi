import { Button, TextArea, TextInput } from "../../ui";
import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";

export function Composer({
  onSend,
  onUpload,
  disabled = false,
  placeholder = "Tell Rumi what to change",
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
    <div className="mt-auto shrink-0">
      {error && (
        <p
          className="text-xs leading-relaxed text-rust [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      )}
      <form
        className="flex items-end gap-1.5 rounded-tile border-[1.5px] border-line bg-white p-1 focus-within:border-teal"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextArea
          embedded
          className="min-h-9 max-h-32 flex-1 px-2 py-2 text-[12.5px] leading-5"
          aria-label="Message Rumi"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled || busy}
          maxLength={16000}
          placeholder={placeholder}
          rows={2}
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

        <TextInput
          ref={file}
          type="file"
          hidden
          disabled={disabled || busy}
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
        <Button
          size="sm"
          type="submit"
          variant="primary"
          className="self-end"
          aria-label="Send message"
          disabled={disabled || busy || !value.trim()}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </form>
      <div className="mt-1 flex items-center justify-between">
        <Button
          size="sm"
          type="button"
          variant="quiet"
          className="size-7 shrink-0 p-1 text-mute"
          aria-label="Attach inspiration image"
          title="Attach an inspiration image"
          disabled={disabled || busy}
          onClick={() => file.current?.click()}
        >
          <ImagePlus size={18} />
        </Button>
        <span className="text-[10px] text-mute">
          Shift + Enter for a new line
        </span>
      </div>
    </div>
  );
}
