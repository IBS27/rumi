import { Button, TextArea, TextInput } from "../../ui";
import { useRef, useState } from "react";
import { ArrowUp, ImagePlus } from "lucide-react";

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
        className="flex flex-col rounded-panel border border-line bg-white p-2 transition-colors focus-within:border-teal/50 focus-within:ring-2 focus-within:ring-teal/10"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextArea
          embedded
          className="min-h-14 max-h-32 w-full px-1.5 py-1 text-[13px] leading-5 focus-visible:!outline-none"
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
        <div className="mt-1 flex items-center gap-2">
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
          <span className="mr-auto text-[10px] text-mute">
            Shift + Enter for a new line
          </span>
          <Button
            size="sm"
            type="submit"
            variant="primary"
            className="size-8 self-end rounded-full border-0 p-1 focus-visible:ring-2 focus-visible:ring-teal/25"
            aria-label="Send message"
            disabled={disabled || busy || !value.trim()}
          >
            <ArrowUp size={17} />
          </Button>
        </div>
      </form>
    </div>
  );
}
