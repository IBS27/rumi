import { describe, expect, it } from "bun:test";
import {
  activeSession,
  chatKey,
  readSessions,
  removeSession,
  renameSession,
  sessionTitle,
  startSession,
  updateActive,
  writeSessions,
  type Workspace,
} from "../src/features/workspace/sessions";
import { importRoomPlan, roomPlanSchema } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const workspace: Workspace = {
  format: "rumi.room",
  version: 1,
  room: importRoomPlan(syntheticRoomPlan, "The corner living room", true),
  original: roomPlanSchema.passthrough().parse(syntheticRoomPlan),
};

describe("sessions", () => {
  it("migrates the legacy room and chat into one session", () => {
    const storage = memoryStorage();
    storage.setItem("rumi.room.v1.u1", JSON.stringify(workspace));
    storage.setItem("rumi.chat.v1.u1", "a".repeat(32));
    const store = readSessions(storage, "u1");
    const session = activeSession(store);
    expect(store.sessions).toHaveLength(1);
    expect(session.workspace?.room.name).toBe("The corner living room");
    expect(storage.getItem(chatKey("u1", session.id))).toBe("a".repeat(32));
    writeSessions(storage, "u1", store);
    expect(storage.getItem("rumi.room.v1.u1")).toBeNull();
    expect(readSessions(storage, "u1")).toEqual(store);
  });

  it("gives each session its own room", () => {
    let store = readSessions(memoryStorage(), "u1", 1);
    const first = activeSession(store).id;
    store = updateActive(store, workspace, 2);
    store = startSession(store, 3);
    expect(activeSession(store).workspace).toBeNull();
    expect(store.sessions).toHaveLength(2);
    // A second "new chat" reuses the empty session.
    expect(startSession(store, 4)).toEqual(store);
    store = updateActive(
      store,
      { ...workspace, room: { ...workspace.room, name: "Bedroom" } },
      5,
    );
    expect(store.sessions.map((s) => s.workspace?.room.name)).toEqual([
      "Bedroom",
      "The corner living room",
    ]);
    store = removeSession(store, first);
    expect(store.sessions).toHaveLength(1);
    expect(activeSession(store).workspace?.room.name).toBe("Bedroom");
    store = removeSession(store, activeSession(store).id);
    expect(store.sessions).toHaveLength(1);
    expect(activeSession(store).workspace).toBeNull();
  });

  it("renames a session and falls back to the room name when cleared", () => {
    let store = updateActive(readSessions(memoryStorage(), "u1", 1), workspace);
    const id = activeSession(store).id;
    store = renameSession(store, id, "  Living room, round two  ");
    expect(sessionTitle(activeSession(store))).toBe("Living room, round two");
    store = renameSession(store, id, "   ");
    expect(activeSession(store).title).toBeUndefined();
    expect(sessionTitle(activeSession(store))).toBe("The corner living room");
  });
});
