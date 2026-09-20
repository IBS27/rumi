import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, TextInput } from "../../ui";

/**
 * The session name in the top bar. Click it to rename in place: Enter or
 * clicking away saves, Esc cancels. An empty name falls back to the room name.
 */
export function SessionTitle({
  value,
  fallback,
  onRename,
}: {
  value: string;
  fallback: string;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelled = useRef(false);
  function start() {
    cancelled.current = false;
    setDraft(value);
    setEditing(true);
  }
  function finish() {
    if (!cancelled.current) onRename(draft);
    setEditing(false);
  }
  if (editing)
    return (
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <TextInput
          aria-label="Session name"
          className="w-[min(40vw,320px)] !py-1 font-display text-base font-medium"
          value={draft}
          maxLength={80}
          placeholder={fallback}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancelled.current = true;
              setEditing(false);
            }
          }}
          onBlur={finish}
        />
      </form>
    );
  return (
    <Button
      variant="quiet"
      title="Rename this session"
      className="group -mx-2 max-w-[40vw] cursor-text gap-1.5 px-2 py-1 font-display text-base font-medium text-ink hover:enabled:bg-wash [&>svg]:size-[13px]"
      onClick={start}
    >
      <span className="truncate">{value}</span>
      <Pencil className="text-mute opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </Button>
  );
}
