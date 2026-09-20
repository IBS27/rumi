import { describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import {
  sampleRoom,
  sampleProposal,
  sampleBrief,
  sampleProducts,
} from "../shared/fixtures";
import { importRoomPlan } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/rooms.ts": () => import("../convex/rooms"),
  "../convex/products.ts": () => import("../convex/products"),
};
const paginationOpts = { numItems: 20, cursor: null };
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
  const other = t.withIdentity({ tokenIdentifier: "test|other" });
  const projectId = await owner.mutation(api.projects.create, {
    title: "My room",
    room: sampleRoom,
  });
  return { t, owner, other, projectId };
}

describe("agent integration with the capture workspace", () => {
  it("requires authentication and derives ownership from the token", async () => {
    const { t, owner, other } = await setup();
    await expect(
      t.mutation(api.projects.create, { title: "Room", room: sampleRoom }),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      t.query(api.projects.list, { paginationOpts }),
    ).rejects.toThrow("UNAUTHENTICATED");
    const projects = await owner.query(api.projects.list, { paginationOpts });
    expect(projects.page[0].ownerId).toBe("test|owner");
    expect(
      (await other.query(api.projects.list, { paginationOpts })).page,
    ).toEqual([]);
    const room = await t.query(internal.rooms.getRoom, {
      roomId: projects.page[0].roomId!,
    });
    expect(room?.snapshot).toEqual(sampleRoom);
  });

  it("prevents another user from reading, changing, or answering a project's chat", async () => {
    const { t, owner, other, projectId } = await setup();
    const messageId = await t.mutation(internal.messages.ask, {
      projectId,
      question: "Which style?",
      options: ["Warm", "Cool"],
      multiSelect: false,
    });
    expect(
      await other.query(api.messages.list, { projectId, paginationOpts }),
    ).toEqual({ page: [], isDone: true, continueCursor: "" });
    await expect(
      other.mutation(api.projects.rename, { projectId, title: "Hijacked" }),
    ).rejects.toThrow();
    await expect(
      other.mutation(api.projects.remove, { projectId }),
    ).rejects.toThrow();
    await expect(
      other.mutation(api.messages.send, { projectId, content: "Hijacked" }),
    ).rejects.toThrow();
    await expect(
      other.mutation(api.messages.answer, { messageId, choice: ["Warm"] }),
    ).rejects.toThrow();
    const messages = await owner.query(api.messages.list, {
      projectId,
      paginationOpts,
    });
    expect(messages?.page).toHaveLength(1);
    expect(messages?.page[0].answer).toBeUndefined();
    expect(messages?.page[0].status).toBe("pending");
    await owner.mutation(api.projects.rename, {
      projectId,
      title: "  Living room  ",
    });
    expect(
      (await owner.query(api.projects.list, { paginationOpts })).page[0].title,
    ).toBe("Living room");
  });

  it("paginates chat and removes children without resurrecting late replies", async () => {
    const { t, owner, projectId } = await setup();
    const ids = await t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < 105; i++)
        ids.push(
          await ctx.db.insert("messages", {
            projectId,
            role: "assistant",
            content: String(i),
            status: "done",
            createdAt: i,
          }),
        );
      return ids;
    });
    const first = await owner.query(api.messages.list, {
      projectId,
      paginationOpts,
    });
    expect(first?.page).toHaveLength(20);
    expect(first?.isDone).toBe(false);
    const next = await owner.query(api.messages.list, {
      projectId,
      paginationOpts: { numItems: 20, cursor: first!.continueCursor },
    });
    expect(next?.page).toHaveLength(20);
    expect(
      next?.page.some((row) => first?.page.some((old) => old._id === row._id)),
    ).toBe(false);
    expect(
      await t.query(internal.messages.history, { projectId }),
    ).toHaveLength(100);
    await owner.mutation(api.projects.remove, { projectId });
    expect(
      await owner.query(api.messages.list, { projectId, paginationOpts }),
    ).toEqual({ page: [], isDone: true, continueCursor: "" });
    await t.mutation(internal.projects.cleanup, { projectId });
    await t.mutation(internal.projects.cleanup, { projectId });
    await t.mutation(internal.messages.complete, {
      messageId: ids[0],
      content: "Late",
      status: "done",
    });
    await expect(
      t.mutation(internal.messages.ask, {
        projectId,
        question: "Late?",
        options: ["Yes", "No"],
        multiSelect: false,
      }),
    ).rejects.toThrow();
    expect(await t.query(internal.messages.history, { projectId })).toEqual([]);
  });

  it("preserves captured polygon rooms and rejects placement outside their floor atomically", async () => {
    const { t, owner } = await setup();
    const room = importRoomPlan(syntheticRoomPlan);
    const projectId = await owner.mutation(api.projects.create, {
      title: "Captured",
      room,
    });
    const project = await t.query(internal.projects.get, { projectId });
    expect(
      (await t.query(internal.rooms.getRoom, { roomId: project!.roomId! }))
        ?.snapshot,
    ).toEqual(room);
    await t.mutation(internal.products.upsertProducts, {
      products: sampleProducts,
    });
    await expect(
      t.mutation(internal.rooms.applyDesignProposal, {
        roomId: project!.roomId!,
        proposal: {
          ...sampleProposal,
          roomId: room.id,
          baseRevision: room.revision,
          additions: sampleProposal.additions.map((object) => ({
            ...object,
            position: { x: 5, y: 0, z: 4 },
          })),
        },
      }),
    ).rejects.toThrow();
    expect(
      (await t.query(internal.rooms.getRoom, { roomId: project!.roomId! }))
        ?.snapshot,
    ).toEqual(room);
  });

  it("applies rectangular proposals once and rejects a stale retry", async () => {
    const { t, projectId } = await setup();
    const project = await t.query(internal.projects.get, { projectId });
    await t.mutation(internal.products.upsertProducts, {
      products: sampleProducts,
    });
    await t.mutation(internal.rooms.patchBrief, {
      roomId: project!.roomId!,
      budgetCents: sampleBrief.budgetCents,
    });
    const args = {
      roomId: project!.roomId!,
      proposal: sampleProposal,
    };
    const updated = await t.mutation(internal.rooms.applyDesignProposal, args);
    expect(updated.revision).toBe(sampleRoom.revision + 1);
    expect(updated.objects.slice(0, sampleRoom.objects.length)).toEqual(
      sampleRoom.objects,
    );
    await expect(
      t.mutation(internal.rooms.applyDesignProposal, args),
    ).rejects.toThrow("room changed");
  });
});
