import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { v } from "convex/values";
import { internalAction } from "../convex/_generated/server";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sampleProducts, sampleRoom } from "../shared/fixtures";
import { MAX_IMAGE_BYTES } from "../shared/chat/uploads";

// Provider actions are excluded from these deterministic boundary tests.
const skipAgent = internalAction({
  args: { projectId: v.id("projects"), messageId: v.id("messages") },
  returns: v.null(),
  handler: async () => null,
});
const skipVision = internalAction({
  args: {
    imageId: v.id("images"),
    userMessageId: v.id("messages"),
    assistantMessageId: v.id("messages"),
  },
  returns: v.null(),
  handler: async () => null,
});
const modules = {
  "../convex/agent.ts": async () => ({ runForProject: skipAgent }),
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/products.ts": () => import("../convex/products"),
  "../convex/images.ts": async () => ({
    ...(await import("../convex/images")),
    analyze: skipVision,
  }),
  "../convex/http.ts": () => import("../convex/http"),
};
const originalSite = process.env.CONVEX_SITE_URL;
const originalOrigins = process.env.CHAT_ALLOWED_ORIGINS;
beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  process.env.CHAT_ALLOWED_ORIGINS = "https://app.example.com";
});
afterAll(() => {
  if (originalSite === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = originalSite;
  if (originalOrigins === undefined) delete process.env.CHAT_ALLOWED_ORIGINS;
  else process.env.CHAT_ALLOWED_ORIGINS = originalOrigins;
});
async function setup(firstMessage?: string) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ tokenIdentifier: "test|chat-owner" });
  const other = t.withIdentity({ tokenIdentifier: "test|other" });
  const projectId = await owner.mutation(api.projects.create, {
    title: "A warmer living room",
    firstMessage,
  });
  return { t, owner, other, projectId };
}

describe("live chat boundaries", () => {
  it("clears a previous recommendation after an empty search and keeps it cleared", async () => {
    const { t, owner, projectId } = await setup("Find a lamp");
    const context = await owner.query(api.projects.context, { projectId });
    const messageId = context!.project.activeMessageId!;
    await t.mutation(internal.products.upsertProducts, {
      products: [sampleProducts[0]],
    });
    const listed = async () =>
      (
        await owner.query(api.messages.list, {
          projectId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page[0];
    await t.mutation(internal.messages.updateProgress, {
      messageId,
      content: "Found a lamp",
      activity: [],
      recommendationProductId: sampleProducts[0].id,
    });
    expect((await listed()).recommendation?.id).toBe(sampleProducts[0].id);
    await t.mutation(internal.messages.updateProgress, {
      messageId,
      content: "Checking another constraint",
      activity: [],
    });
    expect((await listed()).recommendation?.id).toBe(sampleProducts[0].id);
    await t.mutation(internal.messages.updateProgress, {
      messageId,
      content: "No matching product",
      activity: [],
      recommendationProductId: null,
    });
    expect((await listed()).recommendation).toBeNull();
    await t.mutation(internal.messages.complete, {
      messageId,
      content: "No matching product",
      status: "done",
    });
    expect((await listed()).recommendation).toBeNull();
    // Late progress must not restore a card after the reply is complete.
    await t.mutation(internal.messages.updateProgress, {
      messageId,
      content: "Late result",
      activity: [],
      recommendationProductId: sampleProducts[0].id,
    });
    expect((await listed()).recommendation).toBeNull();
  });

  it("starts without invented measurements and saves a brief before a scan exists", async () => {
    const { t, owner, projectId } = await setup("Help me warm up my room.");
    const context = await owner.query(api.projects.context, { projectId });
    expect(context?.room).toBeNull();
    expect(context?.project.activeMessageId).toBeDefined();
    const messages = await t.query(internal.messages.history, { projectId });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[0].content).toBe("Help me warm up my room.");
    expect(messages[1].activity?.[0]).toMatchObject({
      tool: "planning",
      status: "running",
    });
    await t.mutation(internal.products.upsertProducts, {
      products: [sampleProducts[0]],
    });
    await t.mutation(internal.messages.updateProgress, {
      messageId: messages[1]._id,
      content: "I’m reviewing",
      recommendationProductId: sampleProducts[0].id,
      activity: [
        {
          id: "search-1",
          tool: "searchProducts",
          label: "Searching for “warm floor lamp”",
          status: "running",
        },
      ],
    });
    const streaming = await t.query(internal.messages.history, { projectId });
    expect(streaming[1].content).toBe("I’m reviewing");
    expect(streaming[1].activity?.[0].label).toContain("warm floor lamp");
    const listed = await owner.query(api.messages.list, {
      projectId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(listed.page[0].recommendation).toMatchObject({
      id: sampleProducts[0].id,
      name: sampleProducts[0].name,
      sourceUrl: sampleProducts[0].sourceUrl,
    });
    await t.mutation(internal.projects.updateBrief, {
      projectId,
      budgetCents: 50000,
      styles: ["warm"],
    });
    expect(
      (await owner.query(api.projects.context, { projectId }))?.brief
        .budgetCents,
    ).toBe(50000);
    await expect(
      owner.mutation(api.messages.send, {
        projectId,
        content: "Another message",
      }),
    ).rejects.toThrow("wait");
    await t.mutation(internal.messages.complete, {
      messageId: messages[1]._id,
      content: "What do you want to keep?",
      status: "done",
    });
    const completed = await t.query(internal.messages.history, { projectId });
    expect(completed[1].activity?.[0].status).toBe("done");
    expect(
      (await owner.query(api.projects.context, { projectId }))?.project
        .activeMessageId,
    ).toBeUndefined();
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: sampleRoom,
      expectedRevision: null,
    });
    const attached = await owner.query(api.projects.context, { projectId });
    expect(attached?.room).toEqual(sampleRoom);
    expect(attached?.brief.budgetCents).toBe(50000);
  });

  it("treats the old unlimited-budget sentinel as no budget", async () => {
    const { t, owner, projectId } = await setup();
    await t.run(async (ctx) => {
      const project = await ctx.db.get(projectId);
      await ctx.db.patch(projectId, {
        brief: {
          ...project!.brief!,
          budgetCents: Number.MAX_SAFE_INTEGER,
        },
      });
    });
    expect(
      (await owner.query(api.projects.context, { projectId }))?.brief
        .budgetCents,
    ).toBe(0);
  });

  it("starts in Spec, fills old briefs with defaults, and moves stages on request", async () => {
    const { t, owner, projectId } = await setup();
    // A brief stored before the Spec fields existed.
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, {
        brief: {
          prompt: "",
          styles: ["Minimalist"],
          budgetCents: 0,
          currency: "USD",
          restrictions: [],
        },
      });
    });
    const before = await owner.query(api.projects.context, { projectId });
    expect(before?.phase).toBe("spec");
    expect(before?.brief.wants).toEqual([]);
    expect(before?.brief.palette).toEqual([]);
    expect(before?.brief.inspiration).toBe("");
    const saved = await t.mutation(internal.projects.updateBrief, {
      projectId,
      wants: [{ category: "floor lamp", notes: "warm light" }],
      palette: ["#a3b18a"],
      materials: ["oak"],
      inspiration: "Soft, sage-toned Scandinavian bedroom.",
    });
    expect(saved.wants[0].category).toBe("floor lamp");
    expect(saved.styles).toEqual(["Minimalist"]);
    await t.mutation(internal.projects.setPhase, { projectId, phase: "plan" });
    const after = await owner.query(api.projects.context, { projectId });
    expect(after?.phase).toBe("plan");
    expect(after?.brief.materials).toEqual(["oak"]);
  });

  it("rejects cross-user room updates and stale room revisions", async () => {
    const { owner, other, projectId } = await setup();
    expect(await other.query(api.projects.context, { projectId })).toBeNull();
    await expect(
      other.mutation(api.projects.attachRoom, {
        projectId,
        room: sampleRoom,
        expectedRevision: null,
      }),
    ).rejects.toThrow();
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: sampleRoom,
      expectedRevision: null,
    });
    await expect(
      owner.mutation(api.projects.attachRoom, {
        projectId,
        room: sampleRoom,
        expectedRevision: null,
      }),
    ).rejects.toThrow("changed");
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: { ...sampleRoom, name: "Updated" },
      expectedRevision: sampleRoom.revision,
    });
    expect(
      (await owner.query(api.projects.context, { projectId }))?.room?.revision,
    ).toBe(sampleRoom.revision + 1);
  });

  it("accepts custom answers once and persists the pending reply", async () => {
    const { t, owner, projectId } = await setup();
    const messageId = await t.mutation(internal.messages.ask, {
      projectId,
      question: "Which palette?",
      options: ["Warm", "Cool"],
      multiSelect: true,
    });
    const replyId = await owner.mutation(api.messages.answer, {
      messageId,
      choice: ["Warm", "Sage and oak"],
    });
    const messages = await t.query(internal.messages.history, { projectId });
    expect(messages[0].answer).toEqual(["Warm", "Sage and oak"]);
    expect(messages[1].content).toContain("Sage and oak");
    expect(messages[2]._id).toBe(replyId);
    await expect(
      owner.mutation(api.messages.answer, { messageId, choice: ["Cool"] }),
    ).rejects.toThrow();
  });

  it("unblocks failed turns and keeps an old timeout from canceling a retry", async () => {
    const { t, owner, projectId } = await setup("Hello");
    const first = (await t.query(internal.messages.history, { projectId }))[1];
    await t.mutation(internal.messages.expire, { messageId: first._id });
    expect(
      (await owner.query(api.projects.context, { projectId }))?.project
        .activeMessageId,
    ).toBeUndefined();
    await owner.mutation(api.messages.retry, { messageId: first._id });
    const context = await owner.query(api.projects.context, { projectId });
    expect(context?.project.activeMessageId).toBeDefined();
    expect(context?.project.activeMessageId).not.toBe(first._id);
    await t.mutation(internal.messages.expire, { messageId: first._id });
    expect(
      (await owner.query(api.projects.context, { projectId }))?.project
        .activeMessageId,
    ).toBe(context?.project.activeMessageId);
  });
});

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a40kAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("authenticated inspiration uploads", () => {
  it("requires ownership before issuing an upload and bounds image size/type", async () => {
    const { t, owner, other, projectId } = await setup();
    const args = { projectId, contentType: "image/png", size: png.length };
    await expect(t.mutation(api.images.beginUpload, args)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    await expect(
      other.mutation(api.images.beginUpload, args),
    ).rejects.toThrow();
    await expect(
      owner.mutation(api.images.beginUpload, {
        ...args,
        size: MAX_IMAGE_BYTES + 1,
      }),
    ).rejects.toThrow();
    await expect(
      owner.mutation(api.images.beginUpload, {
        ...args,
        contentType: "image/svg+xml",
      }),
    ).rejects.toThrow();
  });

  it("stores a real image through the HTTP route once and keeps it private to its project", async () => {
    const { t, owner, other, projectId } = await setup();
    const { uploadUrl, token } = await owner.mutation(api.images.beginUpload, {
      projectId,
      contentType: "image/png",
      size: png.length,
    });
    const url = new URL(uploadUrl);
    const upload = () =>
      t.fetch(url.pathname + url.search, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "image/png",
          Origin: "https://app.example.com",
        },
        body: png,
      });
    const result = await upload();
    expect(result.status).toBe(200);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect((await upload()).status).toBe(403);
    const messages = await owner.query(api.messages.list, {
      projectId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(messages.page).toHaveLength(2);
    const image = messages.page.find((message) => message.imageId);
    expect(image?.imageUrl).toBeTruthy();
    expect(
      (
        await other.query(api.messages.list, {
          projectId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page,
    ).toEqual([]);
    expect(
      (await owner.query(api.projects.context, { projectId }))?.project
        .activeMessageId,
    ).toBeDefined();
  });

  it("rejects expired tokens and files whose content does not match the declared image", async () => {
    const { t, owner, projectId } = await setup();
    const ticket = await owner.mutation(api.images.beginUpload, {
      projectId,
      contentType: "image/png",
      size: png.length,
    });
    const url = new URL(ticket.uploadUrl);
    const send = (body: Uint8Array) =>
      t.fetch(url.pathname + url.search, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ticket.token}`,
          "Content-Type": "image/png",
        },
        body: new Uint8Array(body),
      });
    expect((await send(new Uint8Array(png.length))).status).toBe(400);
    await t.run(async (ctx) => {
      const uploads = await ctx.db
        .query("imageUploads")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .take(1);
      await ctx.db.patch(uploads[0]._id, { expiresAt: Date.now() - 1 });
    });
    expect((await send(png)).status).toBe(403);
    expect(await t.query(internal.messages.history, { projectId })).toEqual([]);
  });
});
