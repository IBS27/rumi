import { z } from "zod";
import {
  savedRoomSchema,
  type SavedRoom,
} from "../../../shared/capture/roomplan";
import type { CapturedRoom } from "../../../shared/contracts";

/** A room with edits, plus the ID of its detailed scan in this browser. */
export type Workspace = SavedRoom & { room: CapturedRoom; scanId?: string };
export const workspaceSchema = savedRoomSchema.safeExtend({
  scanId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});

const sessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  createdAt: z.number(),
  updatedAt: z.number(),
  title: z.string().trim().min(1).max(80).optional(),
  workspace: workspaceSchema.nullable(),
});
const storeSchema = z.object({
  version: z.literal(1),
  activeId: z.string(),
  sessions: z.array(sessionSchema).min(1),
});

/**
 * One design session: a room (or none yet) and its own chat. Sessions are
 * saved on this browser only, like rooms were before.
 */
export type Session = {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** A name the user typed. Without one, the room name stands in. */
  title?: string;
  workspace: Workspace | null;
};
export type SessionStore = {
  version: 1;
  activeId: string;
  sessions: Session[];
};

export const storeKey = (identity: string) => `rumi.sessions.v1.${identity}`;
const legacyRoomKey = (identity: string) => `rumi.room.v1.${identity}`;
const legacyChatKey = (identity: string) => `rumi.chat.v1.${identity}`;
export const chatKey = (identity: string, sessionId: string) =>
  `rumi.chat.v1.${identity}.${sessionId}`;

export function sessionId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function polygon(workspace: z.infer<typeof workspaceSchema>) {
  return workspace.room.shape === "polygon"
    ? { ...workspace, room: workspace.room }
    : null;
}

export function createSession(now = Date.now()): Session {
  return { id: sessionId(), createdAt: now, updatedAt: now, workspace: null };
}

/** The typed title, else the room name, else a placeholder. */
export function sessionTitle(session: Session) {
  return session.title ?? session.workspace?.room.name ?? "New chat";
}

/** Sets a session's title. An empty title clears it back to the room name. */
export function renameSession(
  store: SessionStore,
  id: string,
  title: string,
): SessionStore {
  const next = title.trim().slice(0, 80);
  return {
    ...store,
    sessions: store.sessions.map((session) =>
      session.id === id ? { ...session, title: next || undefined } : session,
    ),
  };
}

/**
 * Reads the session store. When there is none, migrates the single saved room
 * and chat from earlier versions into one session.
 */
export function readSessions(
  storage: Storage,
  identity: string,
  now = Date.now(),
): SessionStore {
  try {
    const text = storage.getItem(storeKey(identity));
    if (text) {
      const result = storeSchema.safeParse(JSON.parse(text));
      if (result.success) {
        const sessions: Session[] = result.data.sessions.map((session) => ({
          ...session,
          workspace: session.workspace && polygon(session.workspace),
        }));
        const activeId = sessions.some((s) => s.id === result.data.activeId)
          ? result.data.activeId
          : sessions[0].id;
        return { version: 1, activeId, sessions };
      }
    }
  } catch {
    /* Fall through to a fresh store. */
  }
  const first = createSession(now);
  try {
    const legacy = storage.getItem(legacyRoomKey(identity));
    if (legacy) {
      const result = workspaceSchema.safeParse(JSON.parse(legacy));
      if (result.success) first.workspace = polygon(result.data);
    }
    const chat = storage.getItem(legacyChatKey(identity));
    if (chat) storage.setItem(chatKey(identity, first.id), chat);
  } catch {
    /* Legacy data is optional. */
  }
  return { version: 1, activeId: first.id, sessions: [first] };
}

/** Writes the store. Throws when browser storage is full or unavailable. */
export function writeSessions(
  storage: Storage,
  identity: string,
  store: SessionStore,
) {
  storage.setItem(storeKey(identity), JSON.stringify(store));
  storage.removeItem(legacyRoomKey(identity));
  storage.removeItem(legacyChatKey(identity));
}

export function activeSession(store: SessionStore): Session {
  return (
    store.sessions.find((session) => session.id === store.activeId) ??
    store.sessions[0]
  );
}

/** Replaces the active session's room and moves it to the top of the list. */
export function updateActive(
  store: SessionStore,
  workspace: Workspace | null,
  now = Date.now(),
): SessionStore {
  const current = activeSession(store);
  const next = { ...current, workspace, updatedAt: now };
  return {
    ...store,
    activeId: next.id,
    sessions: [next, ...store.sessions.filter((s) => s.id !== next.id)],
  };
}

/**
 * Starts a new session, or reuses the newest empty one so idle "New chat"
 * clicks do not pile up blank sessions.
 */
export function startSession(
  store: SessionStore,
  now = Date.now(),
): SessionStore {
  const empty = store.sessions.find((session) => !session.workspace);
  if (empty) return { ...store, activeId: empty.id };
  const session = createSession(now);
  return {
    ...store,
    activeId: session.id,
    sessions: [session, ...store.sessions],
  };
}

export function selectSession(store: SessionStore, id: string): SessionStore {
  return store.sessions.some((session) => session.id === id)
    ? { ...store, activeId: id }
    : store;
}

/** Removes a session. The store always keeps at least one session. */
export function removeSession(
  store: SessionStore,
  id: string,
  now = Date.now(),
): SessionStore {
  const sessions = store.sessions.filter((session) => session.id !== id);
  if (!sessions.length) {
    const session = createSession(now);
    return { version: 1, activeId: session.id, sessions: [session] };
  }
  return {
    ...store,
    sessions,
    activeId: store.activeId === id ? sessions[0].id : store.activeId,
  };
}
