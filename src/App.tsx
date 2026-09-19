import { useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { ChatLanding } from "./features/chat/ChatLanding";
import { ChatMenu } from "./features/chat/ChatMenu";
import { ChatPanel } from "./features/chat/ChatPanel";
import { RoomPlaceholder } from "./features/room-editor/RoomPlaceholder";
import { useWorkspace } from "./lib/store";

export function App({ connected }: { connected: boolean }) {
  const activeProjectId = useWorkspace((state) => state.activeProjectId);
  const [collapsedProjectId, setCollapsedProjectId] = useState<
    typeof activeProjectId
  >(null);
  const chatCollapsed = collapsedProjectId === activeProjectId;
  if (!connected || !activeProjectId)
    return <ChatLanding connected={connected} />;
  if (chatCollapsed)
    return (
      <main className="relative h-dvh bg-neutral-950 text-neutral-100">
        <RoomPlaceholder />
        <div className="absolute left-4 top-4 flex items-center gap-1 rounded-xl border border-neutral-800 bg-neutral-900/90 p-1 shadow-xl backdrop-blur-md">
          <ChatMenu />
          <div className="h-5 w-px bg-neutral-800" />
          <button
            onClick={() => setCollapsedProjectId(null)}
            aria-label="Expand chat"
            title="Expand chat"
            className="grid size-8 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <PanelLeftOpen className="size-[17px]" />
          </button>
        </div>
      </main>
    );
  return (
    <main className="grid h-dvh grid-cols-[420px_minmax(0,1fr)] bg-neutral-950 text-neutral-100">
      <ChatPanel
        projectId={activeProjectId}
        onCollapse={() => setCollapsedProjectId(activeProjectId)}
      />
      <RoomPlaceholder />
    </main>
  );
}
