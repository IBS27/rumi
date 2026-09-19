import { Sidebar } from "./features/workspace/Sidebar";
import { RoomPlaceholder } from "./features/room-editor/RoomPlaceholder";

export function App() {
  return (
    <main className="workspace-placeholder">
      <Sidebar />
      <RoomPlaceholder />
    </main>
  );
}
