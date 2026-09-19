import { useRef, useState } from "react";
import { ArrowUp, ImagePlus } from "lucide-react";

export function Composer({
  onSend,
  onUpload,
  disabled,
  uploading,
  placeholder,
}: {
  onSend: (text: string) => void;
  onUpload?: (file: File) => void;
  disabled?: boolean;
  uploading?: boolean;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    onSend(text);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="rounded-2xl border border-neutral-700 bg-neutral-900 shadow-[0_8px_32px_rgba(0,0,0,0.4)] transition-colors focus-within:border-neutral-500"
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none bg-transparent px-4 pt-4 text-[15px] leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
      />
      <div className="flex items-center justify-between px-3 pb-3">
        <div>
          {onUpload && (
            <>
              <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(file);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={disabled || uploading}
                aria-label="Upload inspiration image"
                title="Upload inspiration image"
                className="grid size-8 place-items-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
              >
                <ImagePlus className="size-[17px]" />
              </button>
            </>
          )}
        </div>
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="grid size-8 place-items-center rounded-full bg-neutral-100 text-neutral-900 transition-opacity hover:opacity-80 disabled:opacity-30"
        >
          <ArrowUp className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </form>
  );
}
