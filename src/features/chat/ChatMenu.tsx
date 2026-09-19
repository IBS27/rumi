import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Pencil, SquarePen, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { getOwnerId } from "../../lib/clientId";
import { useWorkspace } from "../../lib/store";

export function ChatMenu() {
  const ownerId = getOwnerId();
  const projects = useQuery(api.projects.list, { ownerId });
  const rename = useMutation(api.projects.rename);
  const remove = useMutation(api.projects.remove);
  const { activeProjectId, setActiveProject } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Doc<"projects"> | null>(
    null,
  );
  const [pendingRename, setPendingRename] = useState<Doc<"projects"> | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const go = (id: typeof activeProjectId) => {
    setActiveProject(id);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-label="Chats menu"
        className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[15px] font-semibold tracking-tight text-neutral-100 transition-colors hover:bg-neutral-800"
      >
        rumi
        <ChevronDown className="size-3.5 text-neutral-500" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-11 z-50 w-64 rounded-xl border border-neutral-800 bg-neutral-900 p-1.5 shadow-2xl">
            <button
              onClick={() => go(null)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-neutral-200 transition-colors hover:bg-neutral-800"
            >
              <SquarePen className="size-4 text-neutral-400" />
              New chat
            </button>
            {projects && projects.length > 0 && (
              <>
                <p className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                  History
                </p>
                <div className="max-h-72 overflow-y-auto">
                  {projects.map((project) => (
                    <div
                      key={project._id}
                      className={`group flex items-center rounded-lg transition-colors ${
                        project._id === activeProjectId
                          ? "bg-neutral-800"
                          : "hover:bg-neutral-800"
                      }`}
                    >
                      <button
                        onClick={() => go(project._id)}
                        className={`min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px] ${
                          project._id === activeProjectId
                            ? "text-neutral-100"
                            : "text-neutral-400 group-hover:text-neutral-200"
                        }`}
                      >
                        {project.title}
                      </button>
                      <button
                        onClick={() => {
                          setPendingRename(project);
                          setTitle(project.title);
                        }}
                        aria-label={`Rename ${project.title}`}
                        className="grid size-6 shrink-0 place-items-center rounded text-neutral-500 opacity-0 transition-opacity hover:text-neutral-200 group-hover:opacity-100"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(project)}
                        aria-label={`Delete ${project.title}`}
                        className="mr-1.5 grid size-6 shrink-0 place-items-center rounded text-neutral-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {pendingRename && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60"
          onClick={() => setPendingRename(null)}
        >
          <form
            className="w-80 rounded-2xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onSubmit={async (event) => {
              event.preventDefault();
              if (!title.trim()) return;
              await rename({
                projectId: pendingRename._id,
                ownerId,
                title,
              });
              setPendingRename(null);
            }}
          >
            <h2 className="mb-3 text-[14px] font-medium text-neutral-100">
              Rename chat
            </h2>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mb-4 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-[13px] text-neutral-100 outline-none focus:border-neutral-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRename(null)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-[13px] font-medium text-neutral-900 transition-opacity hover:opacity-80 disabled:opacity-30"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      )}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60"
          onClick={() => setPendingDelete(null)}
        >
          <div
            role="alertdialog"
            aria-label="Delete chat"
            className="w-80 rounded-2xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-1.5 text-[14px] font-medium text-neutral-100">
              Delete this chat?
            </h2>
            <p className="mb-5 text-[13px] leading-5 text-neutral-400">
              "{pendingDelete.title}" and its room will be removed permanently.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await remove({
                    projectId: pendingDelete._id,
                    ownerId,
                  });
                  if (pendingDelete._id === activeProjectId)
                    setActiveProject(null);
                  setPendingDelete(null);
                }}
                className="rounded-lg bg-red-500/90 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-85"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
