import { useState } from "react";
import { useQuery } from "convex/react";
import { House, SquarePen } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { getOwnerId } from "../../lib/clientId";
import { useWorkspace } from "../../lib/store";

export function ChatMenu() {
  const ownerId = getOwnerId();
  const projects = useQuery(api.projects.list, { ownerId });
  const { activeProjectId, setActiveProject } = useWorkspace();
  const [open, setOpen] = useState(false);
  const go = (id: typeof activeProjectId) => {
    setActiveProject(id);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-label="Chats menu"
        className="grid size-9 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      >
        <House className="size-[18px]" />
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
                    <button
                      key={project._id}
                      onClick={() => go(project._id)}
                      className={`block w-full truncate rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                        project._id === activeProjectId
                          ? "bg-neutral-800 text-neutral-100"
                          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                      }`}
                    >
                      {project.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
