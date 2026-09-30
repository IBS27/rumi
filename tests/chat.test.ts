import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { v } from "convex/values";
import { internalAction } from "../convex/_generated/server";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sampleBrief, sampleProducts, sampleRoom } from "../shared/fixtures";
import { MAX_IMAGE_BYTES } from "../shared/chat/uploads";
import { buildDesignPlan } from "../shared/planner";
import { SPEC_SUMMARY_OPTIONS, specStatus } from "../shared/chat/spec";

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
  "../convex/plans.ts": () => import("../convex/plans"),
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

  it("saves a purpose from the user's message before the agent chooses the next Spec question", async () => {
    const { owner } = await setup();
    const projectId = await owner.mutation(api.projects.create, {
      title: "Bedroom furniture",
      room: { ...sampleRoom, name: "My scanned room" },
      firstMessage: "I need some furniture for my bedroom",
    });
    const context = await owner.query(api.projects.context, { projectId });
    expect(context?.brief.purpose).toBe("bedroom");
    expect(specStatus(context!.brief).missing[0]).toBe("style");

    const existing = await setup();
    await existing.owner.mutation(api.messages.send, {
      projectId: existing.projectId,
      content: "Let's find pieces for the living room",
    });
    const updated = await existing.owner.query(api.projects.context, {
      projectId: existing.projectId,
    });
    expect(updated?.brief.purpose).toBe("living room");
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
      palette: ["sage green"],
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

  it("moves to Plan when Start planning is clicked on the summary card, and echoes only a card's first line", async () => {
    const { t, owner, projectId } = await setup();
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: sampleRoom,
      expectedRevision: null,
    });
    const summary = await t.mutation(internal.messages.ask, {
      projectId,
      question: "Here is the brief so far.\nPurpose: bedroom\nStyle: cozy\n\nReady to start planning?",
      options: [...SPEC_SUMMARY_OPTIONS],
      multiSelect: false,
    });
    await owner.mutation(api.messages.answer, { messageId: summary, choice: ["Start planning"] });
    const context = await owner.query(api.projects.context, { projectId });
    expect(context?.phase).toBe("plan");
    const history = await t.query(internal.messages.history, { projectId });
    const turn = history.filter((message) => message.role === "user").at(-1)!;
    expect(turn.content).toBe("Start planning.");
    expect(turn.content).not.toContain("Here is the brief");
    // A normal card keeps a short prefix so the agent knows what was answered.
    await t.mutation(internal.messages.complete, {
      messageId: context!.project.activeMessageId!,
      content: "ok",
      status: "done",
    });
    const style = await t.mutation(internal.messages.ask, {
      projectId,
      question: "Which style direction appeals to you?\nPick one.",
      options: ["Scandinavian", "Industrial"],
      multiSelect: false,
    });
    await owner.mutation(api.messages.answer, { messageId: style, choice: ["Industrial"] });
    const after = await t.query(internal.messages.history, { projectId });
    expect(after.filter((message) => message.role === "user").at(-1)!.content).toBe(
      "Which style direction appeals to you? — Industrial",
    );
  });

  it("shows a plan card, lets the owner keep some zones, then renders one product card per zone", async () => {
    const { t, owner, other, projectId } = await setup();
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: sampleRoom,
      expectedRevision: null,
    });
    const roomId = (await t.run(async (ctx) => (await ctx.db.get(projectId))!.roomId))!;
    const { plan } = buildDesignPlan({
      room: sampleRoom,
      brief: { ...sampleBrief, wants: [{ category: "floor lamp", notes: "" }] },
      products: sampleProducts,
      request: {
        summary: "A reading corner with a soft rug.",
        spacing: "balanced",
        zones: [
          {
            id: "lamp", purpose: "reading light", category: "floor lamp", query: "arc floor lamp",
            mount: "floor", anchor: "near-object", relatedObjectId: "owned-bed",
            desiredFootprint: { width: 0.5, depth: 0.5 }, desiredHeight: 1.8, miscellaneous: [], priority: 1,
          },
          {
            id: "rug", purpose: "soft landing", category: "rug", query: "wool rug",
            mount: "under", anchor: "center", relatedObjectId: null,
            desiredFootprint: { width: 1.6, depth: 2.2 }, desiredHeight: null, miscellaneous: [], priority: 2,
          },
        ],
      },
    });
    const planId = await t.mutation(internal.plans.propose, { projectId, roomId, plan });
    const page = async () =>
      (
        await owner.query(api.messages.list, {
          projectId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page;
    const card = (await page())[0];
    expect(card.kind).toBe("plan");
    expect(card.plan?.planId).toBe(planId);
    expect(card.plan?.zones.map((zone) => [zone.category, zone.suggested, zone.where])).toEqual([
      ["floor lamp", false, "beside the bed"],
      ["rug", true, "on the floor"],
    ]);
    // Only the owner may confirm, and at least one zone must stay.
    await expect(
      other.mutation(api.plans.confirm, { messageId: card._id, zoneIds: ["lamp"] }),
    ).rejects.toThrow();
    await expect(
      owner.mutation(api.plans.confirm, { messageId: card._id, zoneIds: ["nope"] }),
    ).rejects.toThrow("Keep at least one");
    await owner.mutation(api.plans.confirm, { messageId: card._id, zoneIds: ["lamp"] });
    const active = await t.query(internal.plans.active, { projectId });
    expect(active?.status).toBe("searching");
    expect(active?.selectedZoneIds).toEqual(["lamp"]);
    const after = await page();
    expect(after.find((message) => message._id === card._id)?.answer).toEqual(["lamp"]);
    expect(after[1].role).toBe("user");
    expect(after[1].content).toContain("floor lamp");
    // A second confirm is refused; a new proposal supersedes the old plan.
    await expect(
      owner.mutation(api.plans.confirm, { messageId: card._id, zoneIds: ["lamp"] }),
    ).rejects.toThrow();
    // The agent's reply carries one recommendation per searched zone.
    const replyId = after[0]._id;
    await t.mutation(internal.products.upsertProducts, { products: [sampleProducts[0]] });
    await t.mutation(internal.messages.updateProgress, {
      messageId: replyId,
      content: "",
      activity: [],
      recommendations: [
        { zoneId: "lamp", productId: sampleProducts[0].id, fits: "yes", issues: [] },
      ],
    });
    const reply = (await page())[0];
    expect(reply.zoneCards).toEqual([
      {
        zoneId: "lamp",
        category: "floor lamp",
        fits: "yes",
        issues: [],
        product: expect.objectContaining({ id: sampleProducts[0].id }),
      },
    ]);
    const second = await t.mutation(internal.plans.propose, { projectId, roomId, plan });
    expect((await t.query(internal.plans.get, { planId }))?.status).toBe("searching");
    expect((await t.query(internal.plans.get, { planId: second }))?.status).toBe("proposed");
  });

  it("persists cap explanations and searches only the pieces retained on the plan card", async () => {
    const { t, owner, projectId } = await setup();
    const room = { ...sampleRoom, objects: [], openings: [], dimensions: { width: 6, depth: 5, height: 2.7 } };
    await owner.mutation(api.projects.attachRoom, { projectId, room, expectedRevision: null });
    const roomId = (await t.run(async (ctx) => (await ctx.db.get(projectId))!.roomId))!;
    const categories = ["bed", "desk", "chair", "floor lamp", "nightstand", "rug"];
    const { plan } = buildDesignPlan({
      room, products: [], brief: { ...sampleBrief, budgetCents: 0, purpose: "bedroom", wants: [] },
      request: { summary: "Start with the essentials.", spacing: "balanced", zones: categories.map((category, index) => ({
        id: category, category, query: category, purpose: category,
        mount: category === "rug" ? "under" : "floor", anchor: "wall", relatedObjectId: null,
        desiredFootprint: { width: 0.5, depth: 0.5 }, desiredHeight: null, miscellaneous: [], priority: index + 1,
      })) },
    });
    const planId = await t.mutation(internal.plans.propose, { projectId, roomId, plan });
    const page = () => owner.query(api.messages.list, { projectId, paginationOpts: { numItems: 20, cursor: null } });
    const card = (await page()).page.find((message) => message.plan?.planId === planId)!;
    expect(card.plan?.zones).toHaveLength(5);
    expect(card.plan?.rejected[0].reason).toContain("Left out nightstand");
    const kept = plan.zones.map((zone) => zone.id);
    await owner.mutation(api.plans.confirm, { messageId: card._id, zoneIds: [...kept, "nightstand"] });
    const active = await t.query(internal.plans.active, { projectId });
    expect(active?.selectedZoneIds).toEqual(kept);
    const reloaded = (await page()).page.find((message) => message._id === card._id)!;
    expect(reloaded.answer).toEqual(kept);
    expect(reloaded.plan?.rejected).toEqual(card.plan?.rejected);
  });

  it.each([false, true])("rejects stale plans before confirmation or search (confirmed=%s)", async (confirmed) => {
    const { t, owner, projectId } = await setup();
    await owner.mutation(api.projects.attachRoom, {
      projectId, room: sampleRoom, expectedRevision: null,
    });
    const roomId = (await t.run(async (ctx) => (await ctx.db.get(projectId))!.roomId))!;
    const { plan } = buildDesignPlan({
      room: sampleRoom, brief: sampleBrief, products: sampleProducts,
      request: {
        summary: "A reading lamp.", spacing: "balanced",
        zones: [{
          id: "lamp", purpose: "reading light", category: "floor lamp", query: "floor lamp",
          mount: "floor", anchor: "near-object", relatedObjectId: "owned-bed",
          desiredFootprint: { width: 0.5, depth: 0.5 }, desiredHeight: 1.8,
          miscellaneous: [], priority: 1,
        }],
      },
    });
    const planId = await t.mutation(internal.plans.propose, { projectId, roomId, plan });
    const card = (await owner.query(api.messages.list, {
      projectId, paginationOpts: { numItems: 20, cursor: null },
    })).page[0];
    if (confirmed) {
      const replyId = await owner.mutation(api.plans.confirm, {
        messageId: card._id, zoneIds: ["lamp"],
      });
      await t.mutation(internal.messages.complete, {
        messageId: replyId, content: "Try again later.", status: "error",
      });
    }
    await owner.mutation(api.projects.attachRoom, {
      projectId,
      room: { ...sampleRoom, dimensions: { width: 1, depth: 1, height: 2.7 } },
      expectedRevision: 0,
    });
    if (!confirmed) {
      await expect(owner.mutation(api.plans.confirm, {
        messageId: card._id, zoneIds: ["lamp"],
      })).rejects.toThrow("room has changed");
      expect((await t.query(internal.plans.get, { planId }))?.status).toBe("proposed");
      expect((await t.run((ctx) => ctx.db.get(card._id)))?.answer).toBeUndefined();
      expect((await owner.query(api.projects.context, { projectId }))?.project.activeMessageId).toBeUndefined();
    }
    await expect(t.query(internal.plans.active, { projectId })).rejects.toThrow("room has changed");
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
