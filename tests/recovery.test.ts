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
import { sampleProducts } from "../shared/fixtures";

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
  "../convex/plans.ts": () => import("../convex/plans"),
  "../convex/recommendations.ts": () => import("../convex/recommendations"),
  "../convex/design.ts": () => import("../convex/design"),
  "../convex/products.ts": () => import("../convex/products"),
  "../convex/rooms.ts": () => import("../convex/rooms"),
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
    ).toEqual([
      { messageId, attempt: 1 },
      { messageId: image.messageId, attempt: 1 },
    ]);

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

// Scripted OpenAI Responses streams for the real agent action.
const sse = (...output: object[]) =>
  new Response(
    [
      {
        type: "response.created",
        response: { id: "r", created_at: 1, model: "gpt-4o" },
      },
      ...output,
      {
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const briefCall = (id: string, budgetCents: number) => {
  const item = { type: "function_call", id, call_id: id, name: "updateBrief" };
  return sse(
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        ...item,
        arguments: JSON.stringify({ budgetCents }),
        status: "completed",
      },
    },
  );
};
const text = (value: string) =>
  sse(
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m" },
    },
    {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 0,
      content_index: 0,
      delta: value,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "m" },
    },
  );
const until = async (done: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await done()); i++) {
    // Scheduled functions run on real timers; waiting for in-progress ones
    // would block on the model calls this test holds open.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await done()).toBe(true);
};

it("rejects a paused earlier run once recovery starts a newer attempt", async () => {
  const t = convexTest(schema, {
    ...modules,
    "../convex/agent.ts": () => import("../convex/agent"),
  });
  const projectId = await project(t);
  const { messageId } = await pendingReply(t, projectId);
  // Model calls wait for the test to release them, in order.
  const calls: { release: (response: Response) => void }[] = [];
  const originalFetch = globalThis.fetch;
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.openai.com/")) throw new Error(url);
    return new Promise<Response>((release) => calls.push({ release }));
  }) as typeof fetch;
  const read = () => t.run((ctx) => ctx.db.get(messageId));
  const budget = async () =>
    await t.run(async (ctx) => {
      const project = await ctx.db.get(projectId);
      return (await ctx.db.get(project!.roomId!))!.brief.budgetCents;
    });
  try {
    // The original run passes its entry check, then waits on the model.
    const stale = t.action(internal.agent.runForProject, {
      projectId,
      messageId,
    });
    await until(() => calls.length === 1);
    await t.mutation(internal.operations.recover, { cursor: null });
    await until(() => calls.length === 2);
    expect((await read())?.runAttempt).toBe(1);

    // The old model call returns a tool call; none of its writes may land.
    calls[0].release(briefCall("stale", 11100));
    await stale;
    // Its original watchdog also fires late.
    await t.mutation(internal.messages.expire, { messageId });
    expect(await read()).toMatchObject({ status: "pending", runAttempt: 1 });
    expect((await t.run((ctx) => ctx.db.get(projectId)))?.activeMessageId).toBe(
      messageId,
    );
    expect(await budget()).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("agentSteps").collect())).toEqual(
      [],
    );

    // The newer attempt continues and finishes the reply.
    calls[1].release(briefCall("current", 22200));
    await until(() => calls.length === 3);
    calls[2].release(text("Budget saved."));
    await until(async () => (await read())?.status === "done");
    expect((await read())?.content).toBe("Budget saved.");
    expect(await budget()).toBe(22200);
    expect(
      (await t.run((ctx) => ctx.db.get(projectId)))?.activeMessageId,
    ).toBeUndefined();
    expect(calls).toHaveLength(3);
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
});

it("rejects every reply write carrying a superseded attempt", async () => {
  const t = convexTest(schema, modules);
  const projectId = await project(t);
  const { messageId, imageId } = await pendingReply(t, projectId, "pending");
  const { roomId, snapshot } = await t.run(async (ctx) => {
    await ctx.db.patch(messageId, { runAttempt: 1 });
    const roomId = (await ctx.db.get(projectId))!.roomId!;
    return { roomId, snapshot: (await ctx.db.get(roomId))!.snapshot };
  });
  const plan = {
    roomId: snapshot.id,
    baseRevision: snapshot.revision,
    summary: "Plan",
    spacing: "balanced" as const,
    zones: [],
    rejected: [],
    tasks: [],
  };
  const planId = await t.run((ctx) =>
    ctx.db.insert("plans", {
      projectId,
      roomId,
      status: "proposed",
      createdAt: Date.now(),
      plan,
    }),
  );
  const stale = { messageId, attempt: 0 };
  const rejected = "no longer active";
  await expect(
    t.mutation(internal.messages.ask, {
      projectId,
      turnId: messageId,
      attempt: 0,
      question: "Late?",
      options: ["Yes"],
      multiSelect: false,
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.agentSteps.save, {
      projectId,
      ...stale,
      step: 0,
      response: "[]",
      calls: "[]",
      outputs: "{}",
      text: "",
    }),
  ).rejects.toThrow(rejected);
  const stepId = await t.mutation(internal.agentSteps.save, {
    projectId,
    messageId,
    attempt: 1,
    step: 0,
    response: "[]",
    calls: "[]",
    outputs: "{}",
    text: "",
  });
  await expect(
    t.mutation(internal.agentSteps.output, {
      id: stepId,
      attempt: 0,
      callId: "late",
      output: "{}",
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.projects.updateBrief, {
      projectId,
      ...stale,
      budgetCents: 100,
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.projects.setPhase, {
      projectId,
      ...stale,
      phase: "plan",
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.plans.propose, { projectId, roomId, plan, ...stale }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.plans.setStatus, {
      planId,
      ...stale,
      status: "searching",
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.recommendations.save, {
      projectId,
      ...stale,
      zone: null,
      product: sampleProducts[0],
      explanation: "Late",
      result: {
        zoneId: "lamp",
        productId: sampleProducts[0].id,
        fits: "yes",
        issues: [],
      },
    }),
  ).rejects.toThrow(rejected);
  await expect(
    t.mutation(internal.design.editByAgent, {
      projectId,
      ...stale,
      expectedRevision: snapshot.revision,
      commands: [
        { type: "add", productId: sampleProducts[0].id, instanceId: "late" },
      ],
    }),
  ).rejects.toThrow(rejected);
  await t.mutation(internal.images.complete, {
    imageId: imageId!,
    userMessageId: (await t.run((ctx) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("role"), "user"))
        .first(),
    ))!._id,
    assistantMessageId: messageId,
    attempt: 0,
    status: "error",
    analysis: "Late failure",
  });
  await t.mutation(internal.messages.updateProgress, {
    ...stale,
    content: "Late text",
    activity: [],
  });
  await t.mutation(internal.messages.expire, stale);
  await t.mutation(internal.messages.complete, {
    ...stale,
    status: "error",
    content: "Late failure",
  });
  expect(await t.run((ctx) => ctx.db.get(imageId!))).toMatchObject({
    status: "pending",
  });
  expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({
    status: "pending",
    content: "",
  });
  expect(
    await t.run((ctx) => ctx.db.query("recommendations").collect()),
  ).toEqual([]);
  expect((await t.run((ctx) => ctx.db.get(planId)))?.status).toBe("proposed");

  // The current attempt's writes still apply.
  await t.mutation(internal.messages.updateProgress, {
    messageId,
    attempt: 1,
    content: "Working",
    activity: [],
  });
  expect((await t.run((ctx) => ctx.db.get(messageId)))?.content).toBe(
    "Working",
  );
  await t.mutation(internal.messages.complete, {
    messageId,
    attempt: 1,
    status: "done",
    content: "Done",
  });
  expect((await t.run((ctx) => ctx.db.get(messageId)))?.status).toBe("done");
  expect(
    (await t.run((ctx) => ctx.db.get(projectId)))?.activeMessageId,
  ).toBeUndefined();
});

it("fences image analyses started before attempts existed", async () => {
  const t = convexTest(schema, modules);
  // Pre-attempt analyze actions call complete without the reply or attempt.
  const legacy = (
    reply: { imageId?: Id<"images">; userMessageId: Id<"messages"> },
    status: "analyzed" | "error",
  ) =>
    t.mutation(internal.images.complete, {
      imageId: reply.imageId!,
      userMessageId: reply.userMessageId,
      status,
      analysis: status === "analyzed" ? "Style: oak" : "Late failure",
    });
  const state = (reply: {
    imageId?: Id<"images">;
    userMessageId: Id<"messages">;
  }) =>
    t.run(async (ctx) => ({
      image: (await ctx.db.get(reply.imageId!))!.status,
      analysis: (await ctx.db.get(reply.imageId!))!.analysis,
      user: (await ctx.db.get(reply.userMessageId))!.content,
    }));

  // A reply that recovery never touched still accepts its legacy analysis.
  const compatible = await pendingReply(t, await project(t), "pending");
  await legacy(compatible, "analyzed");
  expect(await state(compatible)).toEqual({
    image: "analyzed",
    analysis: "Style: oak",
    user: "I uploaded an inspiration image.",
  });

  // After recovery advances the reply to attempt 1, the old action is stale.
  const recovered = await pendingReply(t, await project(t), "pending");
  await recover(t);
  expect(
    (await t.run((ctx) => ctx.db.get(recovered.messageId)))?.runAttempt,
  ).toBe(1);
  await legacy(recovered, "error");
  await t.mutation(internal.messages.complete, {
    messageId: recovered.messageId,
    status: "error",
    content: "I couldn’t analyze that image. Please try again.",
  });
  expect(await state(recovered)).toEqual({
    image: "pending",
    analysis: undefined,
    user: "Find a lamp",
  });
  expect((await t.run((ctx) => ctx.db.get(recovered.messageId)))?.status).toBe(
    "pending",
  );
  // The recovered attempt's own analysis still lands.
  await t.mutation(internal.images.complete, {
    imageId: recovered.imageId!,
    userMessageId: recovered.userMessageId,
    assistantMessageId: recovered.messageId,
    attempt: 1,
    status: "analyzed",
    analysis: "Style: linen",
  });
  expect((await state(recovered)).analysis).toBe("Style: linen");

  // Once a later turn replaces the reply, a late legacy analysis is dropped.
  const projectId = await project(t);
  const replaced = await pendingReply(t, projectId, "pending");
  await t.mutation(internal.messages.complete, {
    messageId: replaced.messageId,
    status: "error",
    content: "The reply took too long. Please try again.",
  });
  await pendingReply(t, projectId);
  await legacy(replaced, "analyzed");
  expect((await state(replaced)).image).toBe("pending");
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
