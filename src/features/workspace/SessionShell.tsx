import { useRef, useState, type ComponentProps } from "react";
import { RoomWorkspace } from "../room-editor/RoomWorkspace";
import { SessionMenu } from "./SessionMenu";
import { SessionTitle } from "./SessionTitle";
import {
  activeSession,
  readSessions,
  removeSession,
  renameSession,
  selectSession,
  sessionTitle,
  startSession,
  updateActive,
  writeSessions,
  type SessionStore,
  type Workspace,
} from "./sessions";

type WorkspaceProps = Omit<
  ComponentProps<typeof RoomWorkspace>,
  "initial" | "onPersist" | "brand" | "title"
>;

/**
 * Owns the browser-local session list for one identity. Each session has its
 * own room and chat; the active one renders in a RoomWorkspace that remounts
 * on switch so viewer state does not leak between rooms.
 */
export function SessionShell({ identity = "local", ...rest }: WorkspaceProps) {
  const [store, setStore] = useState<SessionStore>(() =>
    readSessions(localStorage, identity),
  );
  // Mirrors `store` so persists from quick successive edits do not see a stale closure.
  const latest = useRef(store);
  const session = activeSession(store);
  function save(next: SessionStore) {
    latest.current = next;
    setStore(next);
    writeSessions(localStorage, identity, next);
  }
  function persist(workspace: Workspace | null) {
    save(updateActive(latest.current, workspace));
  }
  return (
    <RoomWorkspace
      key={session.id}
      identity={identity}
      initial={session.workspace}
      title={
        <SessionTitle
          value={sessionTitle(session)}
          fallback={session.workspace?.room.name ?? "New chat"}
          onRename={(title) =>
            save(renameSession(latest.current, session.id, title))
          }
        />
      }
      onPersist={persist}
      brand={
        <SessionMenu
          sessions={store.sessions}
          activeId={session.id}
          onNew={() => save(startSession(store))}
          onSelect={(id) => save(selectSession(store, id))}
          onRemove={(id) => save(removeSession(store, id))}
        />
      }
      {...rest}
      chat={(context) => rest.chat({ ...context, sessionId: session.id })}
    />
  );
}
