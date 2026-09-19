import { create } from "zustand";
import type { Id } from "../../convex/_generated/dataModel";

interface WorkspaceState {
  activeProjectId: Id<"projects"> | null;
  setActiveProject: (id: Id<"projects"> | null) => void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  activeProjectId: null,
  setActiveProject: (id) => set({ activeProjectId: id }),
}));
