import { useState } from "react";
import { ArrowUp } from "lucide-react";

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
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
      <div className="flex justify-end px-3 pb-3">
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
