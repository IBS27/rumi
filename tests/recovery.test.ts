import { describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import { v, type PropertyValidators } from "convex/values";
import { internalAction } from "../convex/_generated/server";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { emptyBrief } from "../convex/projects";
import { importRoomPlan } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { MAX_RECONSTRUCTION_MS } from "../shared/reconstruction/contracts";

// Backups omit scheduled functions. These tests restore rows directly, with no
// timers, then check that operator recovery re-arms every lifecycle once.
const started: { name: string; args: Record<string, unknown> }[] = [];
const recorder = (name: string, args: PropertyValidators) =>
  internalAction({
    args,
    handler: async (_ctx, input: Record<string, unknown>) => {
      started.push({ name, args: input });
      return null;
    },
  });
const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/operations.ts": () => import("../convex/operations"),
  "../convex/accounts.ts": () => import("../convex/accounts"),
  "../convex/files.ts": () => import("../convex/files"),
  "../convex/captures.ts": () => import("../convex/captures"),
  "../convex/assets.ts": () => import("../convex/assets"),
  "../convex/agentSteps.ts": () => import("../convex/agentSteps"),
  "../convex/roomReconstruction.ts": () =>
    import("../convex/roomReconstruction"),
  "../convex/images.ts": async () => ({
    ...(await import("../convex/images")),
    analyze: recorder("analyze", {
      imageId: v.id("images"),
      userMessageId: v.id("messages"),
      assistantMessageId: v.id("messages"),
      attempt: v.optional(v.number()),
    }),
  }),
  "../convex/agent.ts": async () => ({
    runForProject: recorder("runForProject", {
      projectId: v.id("projects"),
      messageId: v.id("messages"),
      attempt: v.optional(v.number()),
    }),
  }),
  "../convex/accountJobs.ts": async () => ({
    deleteIdentity: recorder("deleteIdentity", {
      ownerId: v.string(),
      subject: v.string(),
      attempt: v.number(),
    }),
  }),
};
const owner = "test|owner";
const room = importRoomPlan(syntheticRoomPlan, "Restored room", true);

async function recover(t: ReturnType<typeof convexTest>) {
  const runs = async () =>
    (await t.run((ctx) => ctx.db.query("operatorEvents").collect())).filter(
      (event) => event.operation === "recover:roomReconstructions",
    ).length;
  const before = await runs();
  await t.mutation(internal.operations.recover, { cursor: null });
  for (let i = 0; i < 200 && (await runs()) === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.finishInProgressScheduledFunctions();
  }
  // Let the zero-delay cleanup batches it scheduled finish too.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.finishInProgressScheduledFunctions();
  }
}
const timers = (t: ReturnType<typeof convexTest>, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name === name && job.state.kind === "pending",
    ),
  );

async function project(
  t: ReturnType<typeof convexTest>,
  ownerId = owner,
): Promise<Id<"projects">> {
  return t.run(async (ctx) => {
    const roomId = await ctx.db.insert("rooms", {
      ownerId,
      snapshot: room,
      brief: emptyBrief(),
    });
    return ctx.db.insert("projects", {
      ownerId,
      title: "Restored",
      roomId,
      createdAt: Date.now(),
    });
  });
}
async function pendingReply(
  t: ReturnType<typeof convexTest>,
  projectId: Id<"projects">,
  image?: "pending" | "analyzed",
) {
  return t.run(async (ctx) => {
    const imageId = image
      ? await ctx.db.insert("images", {
          projectId,
          storageId: await ctx.storage.store(new Blob(["png"])),
          contentType: "image/png",
          status: image,
          createdAt: Date.now(),
        })
      : undefined;
    const userMessageId = await ctx.db.insert("messages", {
      projectId,
      role: "user",
      content: "Find a lamp",
      imageId,
      status: "done",
      createdAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: Date.now() + 1,
    });
    await ctx.db.patch(projectId, { activeMessageId: messageId });
    return { messageId, userMessageId, imageId };
  });
}

describe("recovery after restoring a backup", () => {
  it("resumes each pending reply once per recovery and fences earlier chains", async () => {
    started.length = 0;
    const t = convexTest(schema, modules);
    const chat = await project(t);
    const { messageId } = await pendingReply(t, chat);
    const withImage = await project(t);
    const image = await pendingReply(t, withImage, "pending");
    const finished = await project(t);
    const done = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        projectId: finished,
        role: "assistant",
        content: "Done",
        status: "done",
        createdAt: Date.now(),
      });
      await ctx.db.patch(finished, { activeMessageId: id });
      return id;
    });
    await recover(t);
    expect(started).toEqual([
      {
        name: "runForProject",
        args: { projectId: chat, messageId, attempt: 1 },
      },
      {
        name: "analyze",
        args: {
          imageId: image.imageId,
          userMessageId: image.userMessageId,
          assistantMessageId: image.messageId,
          attempt: 1,
        },
      },
    ]);
    expect(
      (await t.run((ctx) => ctx.db.get(finished)))?.activeMessageId,
    ).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(done)))?.status).toBe("done");
    // Expiry is re-armed so a reply whose worker is lost cannot stay pending.
    expect(
      (await timers(t, "messages:expire")).map((job) => job.args[0]),
    ).toEqual([{ messageId }, { messageId: image.messageId }]);

    // Running recovery again supersedes the chain it started the first time.
    started.length = 0;
    await recover(t);
    expect(started.map((call) => call.args.attempt)).toEqual([2, 2]);
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.runAttempt).toBe(2);
  });

  it("finishes interrupted project and account deletions", async () => {
    started.length = 0;
    const t = convexTest(schema, modules);
    const deleted = await project(t);
    const blobs = await t.run(async (ctx) => {
      const chunk = await ctx.storage.store(new Blob(["private scan"]));
      const photo = await ctx.storage.store(new Blob(["photo"]));
      await ctx.db.insert("files", {
        projectId: deleted,
        ownerId: owner,
        kind: "scan",
        size: 12,
        chunks: [chunk],
        tokenHash: "hash",
        expiresAt: Date.now() + 3600000,
        complete: true,
      });
      await ctx.db.insert("images", {
        projectId: deleted,
        storageId: photo,
        contentType: "image/png",
        status: "analyzed",
        createdAt: Date.now(),
      });
      await ctx.db.insert("messages", {
        projectId: deleted,
        role: "user",
        content: "My bedroom",
        status: "done",
        createdAt: Date.now(),
      });
      // The snapshot was taken after the project row was deleted but before
      // its scheduled cleanup ran.
      const project = (await ctx.db.get(deleted))!;
      await ctx.db.delete(project.roomId!);
      await ctx.db.delete(deleted);
      await ctx.db.insert("projectDeletions", {
        projectId: deleted,
        requestedAt: Date.now(),
      });
      return [chunk, photo];
    });
    const leaving = "test|leaving";
    const kept = await project(t, leaving);
    await t.run((ctx) =>
      ctx.db.insert("accountDeletions", {
        ownerId: leaving,
        subject: "user_leaving",
        requestedAt: Date.now(),
        status: "pending",
      }),
    );
    const unrelated = await project(t, "test|other");
    await recover(t);
    for (const table of ["files", "images", "messages"] as const)
      expect(await t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
    for (const blob of blobs)
      expect(await t.run((ctx) => ctx.storage.get(blob))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(kept))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.query("projectDeletions").collect()),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(unrelated))).not.toBeNull();
    expect(started).toEqual([
      {
        name: "deleteIdentity",
        args: { ownerId: leaving, subject: "user_leaving", attempt: 0 },
      },
    ]);
  });

  it("re-arms upload, ticket, capture, asset and reconstruction expiry", async () => {
    started.length = 0;
    const t = convexTest(schema, modules);
    const projectId = await project(t);
    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const orphan = await ctx.storage.store(new Blob(["partial"]));
      const published = await ctx.storage.store(new Blob(["saved"]));
      const unpublishedId = await ctx.db.insert("files", {
        projectId,
        ownerId: owner,
        kind: "scan",
        size: 100,
        chunks: [orphan],
        tokenHash: "a",
        expiresAt: now - 1,
        complete: false,
      });
      const publishedId = await ctx.db.insert("files", {
        projectId,
        ownerId: owner,
        kind: "workspace",
        size: 5,
        chunks: [published],
        tokenHash: "b",
        expiresAt: now - 1,
        complete: true,
      });
      await ctx.db.patch(projectId, { workspaceFileId: publishedId });
      const ticket = await ctx.db.insert("fileTickets", {
        ownerId: owner,
        projectId,
        fileId: publishedId,
        tokenHash: "c",
        expiresAt: now - 1,
      });
      const capture = await ctx.db.insert("captures", {
        ownerId: owner,
        state: "uploaded",
        pairingHash: "d",
        pairingExpiresAt: now,
        expiresAt: now,
        uploadAttempts: 1,
      });
      await ctx.db.insert("assets", {
        id: "lamp-asset",
        status: "pending",
        url: null,
        accuracy: "approximate",
        scale: 1,
        rotation: { x: 0, y: 0, z: 0 },
        attempt: 2,
        updatedAt: now - 600000,
      });
      const job = await ctx.db.insert("roomReconstructions", {
        ownerId: owner,
        projectId,
        digest: "e",
        inputId: await ctx.storage.store(new Blob(["evidence"])),
        stage: "modeling",
        attempt: 2,
        step: 3,
        completed: 1,
        total: 4,
      });
      return {
        orphan,
        published,
        unpublishedId,
        publishedId,
        ticket,
        capture,
        job,
      };
    });
    await recover(t);
    expect(await t.run((ctx) => ctx.db.get(ids.unpublishedId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(ids.orphan))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ids.publishedId))).not.toBeNull();
    expect(
      await t.run(
        async (ctx) => (await ctx.storage.get(ids.published)) !== null,
      ),
    ).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(ids.ticket))).toBeNull();
    const asset = await t.run((ctx) =>
      ctx.db
        .query("assets")
        .withIndex("by_catalog_id", (q) => q.eq("id", "lamp-asset"))
        .unique(),
    );
    expect(asset?.status).toBe("failed");
    const [capture] = await timers(t, "captures:removeExpired");
    expect(capture.args[0]).toEqual({ sessionId: ids.capture });
    const created = (await t.run((ctx) => ctx.db.get(ids.capture)))!
      ._creationTime;
    expect(capture.scheduledTime).toBe(created + 24 * 60 * 60 * 1000);
    const [job] = await timers(t, "roomReconstruction:expire");
    expect(job.args[0]).toEqual({ id: ids.job, attempt: 2, step: 3 });
    expect(job.scheduledTime).toBeGreaterThanOrEqual(
      now + MAX_RECONSTRUCTION_MS,
    );
  });
});

it("stops a stale reply chain before it does any work", async () => {
  const t = convexTest(schema, {
    ...modules,
    "../convex/agent.ts": () => import("../convex/agent"),
  });
  const projectId = await project(t);
  const { messageId } = await pendingReply(t, projectId);
  await t.run((ctx) => ctx.db.patch(messageId, { runAttempt: 2 }));
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await t.action(internal.agent.runForProject, {
      projectId,
      messageId,
      attempt: 1,
    });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.status).toBe(
      "pending",
    );
    // The current attempt proceeds; here it stops at the missing model key.
    await t.action(internal.agent.runForProject, {
      projectId,
      messageId,
      attempt: 2,
    });
    expect((await t.run((ctx) => ctx.db.get(messageId)))?.status).toBe("error");
  } finally {
    if (key !== undefined) process.env.OPENAI_API_KEY = key;
  }
});

it("records a tombstone until a deleted project's children are gone", async () => {
  const t = convexTest(schema, modules);
  const projectId = await t
    .withIdentity({ tokenIdentifier: owner })
    .mutation(api.projects.create, { title: "Room", room });
  await t
    .withIdentity({ tokenIdentifier: owner })
    .mutation(api.projects.remove, { projectId });
  expect(
    (await t.run((ctx) => ctx.db.query("projectDeletions").collect())).map(
      (row) => row.projectId,
    ),
  ).toEqual([projectId]);
  await t.finishInProgressScheduledFunctions();
  await t.mutation(internal.projects.cleanup, { projectId });
  expect(
    await t.run((ctx) => ctx.db.query("projectDeletions").collect()),
  ).toEqual([]);
});
