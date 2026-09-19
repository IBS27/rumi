import { ChatLanding } from "./features/chat/ChatLanding";
import { ChatPanel } from "./features/chat/ChatPanel";
import { RoomPlaceholder } from "./features/room-editor/RoomPlaceholder";
import { useWorkspace } from "./lib/store";

export function App({ connected }: { connected: boolean }) {
  const activeProjectId = useWorkspace((state) => state.activeProjectId);
  if (!connected || !activeProjectId)
    return <ChatLanding connected={connected} />;
  return (
    <main className="grid h-dvh grid-cols-[420px_minmax(0,1fr)] bg-neutral-950 text-neutral-100">
      <ChatPanel projectId={activeProjectId} />
      <RoomPlaceholder />
    </main>
  );
}
