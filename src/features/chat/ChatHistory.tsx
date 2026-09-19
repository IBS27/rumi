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
    <div className="chat-history">
      <div className="history-heading">
        <button
          className="icon-button"
          aria-label="Back to chat"
          onClick={onClose}
        >
          <ArrowLeft size={17} />
        </button>
        <h3>Your conversations</h3>
      </div>
      <button className="history-new" onClick={() => onSelect(null)}>
        <Plus size={17} /> New conversation
      </button>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {status === "LoadingFirstPage" && (
        <p className="muted">Loading conversations…</p>
      )}
      {status !== "LoadingFirstPage" && !results.length && (
        <p className="muted">Your conversations will appear here.</p>
      )}
      {results.map((project) => (
        <div className="history-item" key={project._id}>
          <div className="history-row">
            <button
              className="history-title"
              aria-current={activeId === project._id ? "true" : undefined}
              onClick={() => onSelect(project._id)}
            >
              {project.title}
            </button>
            <button
              className="icon-button"
              aria-label={`Rename ${project.title}`}
              disabled={busy}
              onClick={() => {
                setEditing(project._id);
                setTitle(project.title);
                setDeleting(null);
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-button"
              aria-label={`Delete ${project.title}`}
              disabled={busy}
              onClick={() => {
                setDeleting(project._id);
                setEditing(null);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {editing === project._id && (
            <form
              className="history-edit"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => rename({ projectId: project._id, title }));
              }}
            >
              <input
                aria-label="Chat title"
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
              <div>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy || !title.trim()}>
                  Save name
                </button>
              </div>
            </form>
          )}
          {deleting === project._id && (
            <div
              className="history-delete"
              role="group"
              aria-label="Confirm chat deletion"
            >
              <p>
                Delete “{project.title}” and its conversation? Your room on this
                device will stay.
              </p>
              <button disabled={busy} onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await remove({ projectId: project._id });
                    if (activeId === project._id) onSelect(null);
                  })
                }
              >
                Delete conversation
              </button>
            </div>
          )}
        </div>
      ))}
      {status === "CanLoadMore" && (
        <button onClick={() => loadMore(20)}>Load more conversations</button>
      )}
    </div>
  );
}
