import { Button, TextInput } from "../../ui";
import { useState } from "react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { Pencil, Trash2, Plus, ArrowLeft } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export function ChatHistory({
  activeId,
  onSelect,
  onClose,
}: {
  activeId: Id<"projects"> | null;
  onSelect: (id: Id<"projects"> | null) => void;
  onClose: () => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.list,
    {},
    { initialNumItems: 20 },
  );
  const rename = useMutation(api.projects.rename);
  const remove = useMutation(api.projects.remove);
  const [editing, setEditing] = useState<Id<"projects"> | null>(null);
  const [deleting, setDeleting] = useState<Id<"projects"> | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function perform(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      setEditing(null);
      setDeleting(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update this chat.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-0 overflow-y-auto text-[12.5px]">
      <div className="mb-3 flex items-center gap-2 [&>h3]:font-display [&>h3]:text-base">
        <Button
          size="sm"
          variant="quiet"
          className="size-7 shrink-0 p-1 text-mute"
          aria-label="Back to chat"
          onClick={onClose}
        >
          <ArrowLeft size={17} />
        </Button>
        <h3>Your conversations</h3>
      </div>
      <Button
        size="sm"
        className="mb-3 w-full justify-start"
        onClick={() => onSelect(null)}
      >
        <Plus size={17} /> New conversation
      </Button>
      {error && (
        <p
          role="alert"
          className="text-xs leading-relaxed text-rust [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {status === "LoadingFirstPage" && (
        <p className="text-mute">Loading conversations…</p>
      )}
      {status !== "LoadingFirstPage" && !results.length && (
        <p className="text-mute">Your conversations will appear here.</p>
      )}
      {results.map((project) => (
        <div className="min-w-0" key={project._id}>
          <div className="flex items-center gap-0.5 border-b border-line py-1">
            <Button
              size="sm"
              className="min-w-0 flex-1 justify-start whitespace-normal text-left font-normal [overflow-wrap:anywhere] aria-[current=true]:bg-teal-tint aria-[current=true]:font-semibold"
              aria-current={activeId === project._id ? "true" : undefined}
              onClick={() => onSelect(project._id)}
            >
              {project.title}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              className="size-7 shrink-0 p-1 text-mute"
              aria-label={`Rename ${project.title}`}
              disabled={busy}
              onClick={() => {
                setEditing(project._id);
                setTitle(project.title);
                setDeleting(null);
              }}
            >
              <Pencil size={14} />
            </Button>
            <Button
              size="sm"
              variant="quiet"
              className="size-7 shrink-0 p-1 text-mute"
              aria-label={`Delete ${project.title}`}
              disabled={busy}
              onClick={() => {
                setDeleting(project._id);
                setEditing(null);
              }}
            >
              <Trash2 size={14} />
            </Button>
          </div>
          {editing === project._id && (
            <form
              className="my-1.5 rounded-ctrl bg-stone p-2.5 [&>div]:mt-2 [&>div]:flex [&>div]:justify-end [&>div]:gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => rename({ projectId: project._id, title }));
              }}
            >
              <TextInput
                aria-label="Chat title"
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
              <div>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  variant="primary"
                  disabled={busy || !title.trim()}
                >
                  Save name
                </Button>
              </div>
            </form>
          )}
          {deleting === project._id && (
            <div
              className="my-1.5 rounded-ctrl bg-stone p-2.5 [&>button]:mt-2 [&>button]:mr-1"
              role="group"
              aria-label="Confirm chat deletion"
            >
              <p>
                Delete “{project.title}” and its conversation? Your room on this
                device will stay.
              </p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await remove({ projectId: project._id });
                    if (activeId === project._id) onSelect(null);
                  })
                }
              >
                Delete conversation
              </Button>
            </div>
          )}
        </div>
      ))}
      {status === "CanLoadMore" && (
        <Button size="sm" onClick={() => loadMore(20)}>
          Load more conversations
        </Button>
      )}
    </div>
  );
}
