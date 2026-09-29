import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { v } from "convex/values";
import { internalAction } from "../convex/_generated/server";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { importRoomPlan } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { sampleProducts } from "../shared/fixtures";
import { selectionTotal } from "../shared/budget";
import { productIdFor } from "../shared/search";
import { assetKey } from "../shared/catalog/identity";
import {
  buildCandidate,
  pickFacts,
  NO_FACTS,
} from "../shared/search/candidate";
import { hashToken } from "../shared/capture/pairing";
const originalSite = process.env.CONVEX_SITE_URL;
beforeAll(() => {
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
});
afterAll(() => {
  if (originalSite === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = originalSite;
});
const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/plans.ts": () => import("../convex/plans"),
  "../convex/design.ts": () => import("../convex/design"),
  "../convex/products.ts": () => import("../convex/products"),
  "../convex/assets.ts": () => import("../convex/assets"),
  "../convex/agentSteps.ts": () => import("../convex/agentSteps"),
  "../convex/recommendations.ts": () => import("../convex/recommendations"),
  "../convex/files.ts": () => import("../convex/files"),
  "../convex/sourceCache.ts": () => import("../convex/sourceCache"),
  "../convex/accounts.ts": () => import("../convex/accounts"),
  "../convex/migrations.ts": () => import("../convex/migrations"),
  "../convex/http.ts": () => import("../convex/http"),
  "../convex/agent.ts": async () => ({
    runForProject: internalAction({
      args: { projectId: v.id("projects"), messageId: v.id("messages") },
      handler: async () => null,
    }),
  }),
};
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
  const other = t.withIdentity({ tokenIdentifier: "test|other" });
  const room = importRoomPlan(syntheticRoomPlan, "My room", true);
  const projectId = await owner.mutation(api.projects.create, {
    title: "My room",
    room,
  });
  return { t, owner, other, room, projectId };
}
const add = {
  type: "add" as const,
  productId: sampleProducts[0].id,
  instanceId: "lamp",
};

describe("catalog integrity", () => {
  it("separates the two formerly colliding merchant URLs", () => {
    expect(
      productIdFor("https://merchant.com/products/1xeldla-2zlbth", "default"),
    ).not.toBe(
      productIdFor("https://merchant.com/products/3iro7a-1uz5c6l", "default"),
    );
    expect(productIdFor("https://example.com/product?utm_source=a", "42")).toBe(
      productIdFor("https://example.com/product", "42"),
    );
  });
  it("does not label CAD or unknown prices as USD, even with a later USD source", () => {
    const facts = pickFacts([
      { ...NO_FACTS, name: "Desk", priceCents: 10000, currency: "CAD" },
      { priceCents: 15000, currency: "USD" },
    ]);
    expect(
      buildCandidate({
        facts,
        category: "desk",
        sourceUrl: "https://example.com/product",
        measurement: sampleProducts[0].measurement,
      }).product,
    ).toBeNull();
    expect(facts.currency).toBe("CAD");
  });
  it("keeps selected prices and asset versions stable after a catalog refresh", async () => {
    const { t, owner, projectId } = await setup();
    const first = await owner.mutation(api.design.edit, {
      projectId,
      expectedRevision: 0,
      commands: [add],
      operationKey: "first",
    });
    await t.mutation(internal.products.upsertProducts, {
      products: [{ ...sampleProducts[0], priceCents: 99000 }],
    });
    const state = await owner.query(api.design.get, { projectId });
    expect(selectionTotal(state!.room, state!.products)).toBe(
      sampleProducts[0].priceCents,
    );
    expect(
      state!.room.objects.find((object) => object.id === "lamp")
        ?.productSnapshot,
    ).toEqual(
      first.objects.find((object) => object.id === "lamp")?.productSnapshot,
    );
    expect(assetKey(sampleProducts[0])).not.toBe(
      assetKey({
        ...sampleProducts[0],
        images: ["https://example.com/new-photo"],
      }),
    );
  });
});

describe("durable project writes", () => {
  it("replays an edit once and rejects reusing its key for a different command", async () => {
    const { owner, projectId } = await setup();
    const args = {
      projectId,
      expectedRevision: 0,
      commands: [add],
      operationKey: "operation",
    };
    const first = await owner.mutation(api.design.edit, args);
    expect(await owner.mutation(api.design.edit, args)).toEqual(first);
    await expect(
      owner.mutation(api.design.edit, {
        ...args,
        commands: [{ ...add, instanceId: "other" }],
      }),
    ).rejects.toThrow("another edit");
    expect(
      (await owner.query(api.design.get, { projectId }))?.room.revision,
    ).toBe(1);
  });
  it("fences late brief, phase, question, recommendation, and step writes", async () => {
    const { t, owner, projectId } = await setup();
    const messageId = await owner.mutation(api.messages.send, {
      projectId,
      content: "Hello",
    });
    await t.mutation(internal.messages.complete, {
      messageId,
      content: "Failed",
      status: "error",
    });
    await expect(
      t.mutation(internal.projects.updateBrief, {
        projectId,
        messageId,
        budgetCents: 90000,
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      t.mutation(internal.projects.setPhase, {
        projectId,
        messageId,
        phase: "plan",
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      t.mutation(internal.messages.ask, {
        projectId,
        turnId: messageId,
        question: "Late?",
        options: ["Yes", "No"],
        multiSelect: false,
      }),
    ).rejects.toThrow("no longer active");
    await expect(
      t.mutation(internal.agentSteps.save, {
        projectId,
        messageId,
        step: 0,
        response: "[]",
        calls: "[]",
        outputs: "{}",
        text: "",
      }),
    ).rejects.toThrow("no longer active");
  });
  it("retains completed tool results when retrying a failed reply", async () => {
    const { t, owner, projectId } = await setup();
    const messageId = await owner.mutation(api.messages.send, {
      projectId,
      content: "Find a lamp",
    });
    const stepId = await t.mutation(internal.agentSteps.save, {
      projectId,
      messageId,
      step: 0,
      response: "[]",
      calls: "[]",
      outputs: "{}",
      text: "",
    });
    await t.mutation(internal.agentSteps.output, {
      id: stepId,
      callId: "edit-1",
      output: '{"revision":1}',
    });
    await t.mutation(internal.messages.complete, {
      messageId,
      content: "Interrupted",
      status: "error",
    });
    await owner.mutation(api.messages.retry, { messageId });
    const replyId = (await owner.query(api.projects.context, { projectId }))!
      .project.activeMessageId!;
    const steps = await t.query(internal.agentSteps.list, {
      messageId: replyId,
    });
    expect(JSON.parse(steps[0].outputs)).toEqual({ "edit-1": { revision: 1 } });
  });
  it("keeps recommendations after more than 30 conversation messages", async () => {
    const { t, owner, projectId } = await setup();
    const messageId = await owner.mutation(api.messages.send, {
      projectId,
      content: "Find furniture",
    });
    await t.mutation(internal.recommendations.save, {
      projectId,
      messageId,
      zone: null,
      result: {
        zoneId: "lamp",
        productId: sampleProducts[0].id,
        fits: "yes",
        issues: [],
      },
      product: sampleProducts[0],
      explanation: "Fits",
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++)
        await ctx.db.insert("messages", {
          projectId,
          role: "user",
          status: "done",
          content: `Later ${i}`,
          createdAt: Date.now() + i,
        });
    });
    expect(
      (await owner.query(api.design.get, { projectId }))!.recommendations.map(
        (row) => row.product.id,
      ),
    ).toEqual([sampleProducts[0].id]);
  });
  it("deduplicates a browser migration on reconnect", async () => {
    const { owner, room } = await setup();
    const args = { title: "Imported", room, importKey: "browser-session" };
    expect(await owner.mutation(api.projects.create, args)).toBe(
      await owner.mutation(api.projects.create, args),
    );
  });
});

describe("private project files and deletion", () => {
  it("restores a file for its owner, rejects other users and revokes downloads on deletion", async () => {
    const { t, owner, other, projectId } = await setup();
    const upload = await owner.mutation(api.files.begin, {
      projectId,
      kind: "workspace",
      size: 3,
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["abc"])),
    );
    await t.mutation(internal.files.append, {
      fileId: upload.fileId,
      tokenHash: await hashToken(upload.token),
      index: 0,
      storageId,
    });
    await owner.mutation(api.files.publish, {
      projectId,
      workspaceFileId: upload.fileId,
    });
    await expect(
      other.mutation(api.files.ticket, { projectId, kind: "workspace" }),
    ).rejects.toThrow("not found");
    const ticket = await owner.mutation(api.files.ticket, {
      projectId,
      kind: "workspace",
    });
    const url = new URL(ticket!.url);
    const response = await t.fetch(url.pathname + url.search);
    expect(await response.text()).toBe("abc");
    await owner.mutation(api.projects.remove, { projectId });
    expect((await t.fetch(url.pathname + url.search)).status).toBe(404);
    await t.mutation(internal.projects.cleanup, { projectId });
    expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
  });
  it("rejects out-of-order and wrong-size chunks without completing a file", async () => {
    const { t, owner, projectId } = await setup();
    const upload = await owner.mutation(api.files.begin, {
      projectId,
      kind: "scan",
      size: 3,
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["ab"])));
    const args = {
      fileId: upload.fileId,
      tokenHash: await hashToken(upload.token),
      storageId,
    };
    await expect(
      t.mutation(internal.files.append, { ...args, index: 1 }),
    ).rejects.toThrow("order");
    await expect(
      t.mutation(internal.files.append, { ...args, index: 0 }),
    ).rejects.toThrow("size");
    expect(
      await owner.mutation(api.files.ticket, { projectId, kind: "scan" }),
    ).toBeNull();
  });
  it("deletes plans, uploads, checkpoints, recommendations and reconstruction blobs", async () => {
    const { t, owner, projectId } = await setup();
    const blob = await t.run((ctx) =>
      ctx.storage.store(new Blob(["evidence"])),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("imageUploads", {
        projectId,
        ownerId: "test|owner",
        tokenHash: "hash",
        contentType: "image/png",
        size: 3,
        expiresAt: Date.now() + 1e5,
      });
      await ctx.db.insert("roomReconstructions", {
        projectId,
        ownerId: "test|owner",
        digest: "digest",
        inputId: blob,
        stage: "failed",
        attempt: 1,
        completed: 0,
        total: 1,
      });
    });
    const messageId = await owner.mutation(api.messages.send, {
      projectId,
      content: "Hi",
    });
    await t.mutation(internal.agentSteps.save, {
      projectId,
      messageId,
      step: 0,
      response: "[]",
      calls: "[]",
      outputs: "{}",
      text: "",
    });
    await t.run(async (ctx) => {
      const project = (await ctx.db.get(projectId))!;
      const room = (await ctx.db.get(project.roomId!))!;
      await ctx.db.insert("plans", {
        projectId,
        roomId: room._id,
        status: "proposed",
        createdAt: Date.now(),
        plan: {
          roomId: room.snapshot.id,
          baseRevision: room.snapshot.revision,
          summary: "Plan",
          spacing: "balanced",
          zones: [],
          rejected: [],
          tasks: [],
        },
      });
    });
    await t.mutation(internal.recommendations.save, {
      projectId,
      messageId,
      zone: null,
      product: sampleProducts[0],
      explanation: "Fits",
      result: {
        zoneId: "lamp",
        productId: sampleProducts[0].id,
        fits: "yes",
        issues: [],
      },
    });
    await owner.mutation(api.projects.remove, { projectId });
    await t.mutation(internal.projects.cleanup, { projectId });
    expect(await t.run((ctx) => ctx.db.query("plans").collect())).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("recommendations").collect()),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("agentSteps").collect())).toEqual(
      [],
    );
    expect(
      await t.run((ctx) => ctx.db.query("imageUploads").collect()),
    ).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.query("roomReconstructions").collect()),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.storage.get(blob))).toBeNull();
  });
});

it("revokes account downloads immediately and blocks new work while deletion runs", async () => {
  const { t, owner, projectId } = await setup();
  const upload = await owner.mutation(api.files.begin, {
    projectId,
    kind: "workspace",
    size: 3,
  });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["abc"])));
  await t.mutation(internal.files.append, {
    fileId: upload.fileId,
    tokenHash: await hashToken(upload.token),
    index: 0,
    storageId,
  });
  await owner.mutation(api.files.publish, {
    projectId,
    workspaceFileId: upload.fileId,
  });
  const ticket = await owner.mutation(api.files.ticket, {
    projectId,
    kind: "workspace",
  });
  await t.mutation(internal.accounts.beginDeletion, { ownerId: "test|owner" });
  expect(
    (await t.fetch(`/files/download?${ticket!.url.split("?")[1]}`)).status,
  ).toBe(404);
  await expect(
    owner.mutation(api.projects.create, { title: "Late project" }),
  ).rejects.toThrow("deletion");
  await t.mutation(internal.accounts.cleanup, { ownerId: "test|owner" });
  await t.mutation(internal.projects.cleanup, { projectId });
  expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
  expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
});

it("single-flights merchant loads and rejects a late cache writer", async () => {
  const { t } = await setup();
  expect(
    (
      await t.mutation(internal.sourceCache.acquire, {
        key: "page",
        token: "one",
      })
    ).acquired,
  ).toBe(true);
  expect(
    (
      await t.mutation(internal.sourceCache.acquire, {
        key: "page",
        token: "two",
      })
    ).acquired,
  ).toBe(false);
  const stale = await t.run((ctx) => ctx.storage.store(new Blob(["stale"])));
  await t.mutation(internal.sourceCache.finish, {
    key: "page",
    token: "two",
    storageId: stale,
  });
  expect(await t.run((ctx) => ctx.storage.get(stale))).toBeNull();
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["page"])));
  await t.mutation(internal.sourceCache.finish, {
    key: "page",
    token: "one",
    storageId,
  });
  expect(
    (
      await t.mutation(internal.sourceCache.acquire, {
        key: "page",
        token: "three",
      })
    ).storageId,
  ).toBe(storageId);
});

it("replaces an unsuccessful zone search with a successful retry", async () => {
  const { t, owner, projectId } = await setup();
  const messageId = await owner.mutation(api.messages.send, {
    projectId,
    content: "Find a lamp",
  });
  const args = {
    projectId,
    messageId,
    zone: null,
    explanation: "No products",
    product: null,
    result: {
      zoneId: "lamp",
      productId: null,
      fits: "unknown" as const,
      issues: [],
    },
  };
  const first = await t.mutation(internal.recommendations.save, args);
  expect(
    await t.mutation(internal.recommendations.save, {
      ...args,
      product: sampleProducts[0],
      explanation: "Fits",
      result: { ...args.result, productId: sampleProducts[0].id, fits: "yes" },
    }),
  ).toBe(first);
  const recommendations = (await owner.query(api.design.get, { projectId }))!
    .recommendations;
  expect(recommendations.map((row) => row.product.id)).toEqual([
    sampleProducts[0].id,
  ]);
});

it("rejects an in-flight agent edit and file upload after account deletion begins", async () => {
  const { t, owner, projectId } = await setup();
  const messageId = await owner.mutation(api.messages.send, {
    projectId,
    content: "Place a lamp",
  });
  const upload = await owner.mutation(api.files.begin, {
    projectId,
    kind: "workspace",
    size: 3,
  });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["abc"])));
  await t.mutation(internal.accounts.beginDeletion, { ownerId: "test|owner" });
  await expect(
    t.mutation(internal.design.editByAgent, {
      projectId,
      messageId,
      expectedRevision: 0,
      commands: [add],
      operationKey: "late",
    }),
  ).rejects.toThrow("deletion");
  await expect(
    t.mutation(internal.files.append, {
      fileId: upload.fileId,
      tokenHash: await hashToken(upload.token),
      index: 0,
      storageId,
    }),
  ).rejects.toThrow("expired");
});

it("keeps images private and rejects expired image tickets", async () => {
  const { t, owner, other, projectId } = await setup();
  const imageId = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["private image"], { type: "image/png" }),
    );
    return ctx.db.insert("images", {
      projectId,
      storageId,
      contentType: "image/png",
      status: "analyzed",
      createdAt: Date.now(),
    });
  });
  await expect(
    other.mutation(api.files.ticket, { projectId, imageId }),
  ).rejects.toThrow("not found");
  const ticket = await owner.mutation(api.files.ticket, { projectId, imageId });
  const url = new URL(ticket!.url);
  expect(await (await t.fetch(url.pathname + url.search)).text()).toBe(
    "private image",
  );
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("fileTickets").collect())
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });
  expect((await t.fetch(url.pathname + url.search)).status).toBe(404);
});

it("publishes a matching source pair atomically and cleans unpublished uploads", async () => {
  const { t, owner, projectId } = await setup();
  async function staged(kind: "workspace" | "scan", content: string) {
    const grant = await owner.mutation(api.files.begin, {
      projectId,
      kind,
      size: content.length,
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([content])),
    );
    await t.mutation(internal.files.append, {
      fileId: grant.fileId,
      tokenHash: await hashToken(grant.token),
      index: 0,
      storageId,
    });
    return { ...grant, storageId };
  }
  const old = await staged("workspace", "old");
  await owner.mutation(api.files.publish, {
    projectId,
    workspaceFileId: old.fileId,
  });
  const next = await staged("workspace", "new");
  const scan = await owner.mutation(api.files.begin, {
    projectId,
    kind: "scan",
    size: 3,
  });
  await expect(
    owner.mutation(api.files.publish, {
      projectId,
      workspaceFileId: next.fileId,
      scanFileId: scan.fileId,
    }),
  ).rejects.toThrow("incomplete");
  expect(
    (await owner.query(api.projects.context, { projectId }))!.project
      .workspaceFileId,
  ).toBe(old.fileId);
  const scanBlob = await t.run((ctx) => ctx.storage.store(new Blob(["zip"])));
  await t.mutation(internal.files.append, {
    fileId: scan.fileId,
    tokenHash: await hashToken(scan.token),
    index: 0,
    storageId: scanBlob,
  });
  await owner.mutation(api.files.publish, {
    projectId,
    workspaceFileId: next.fileId,
    scanFileId: scan.fileId,
  });
  const project = (await owner.query(api.projects.context, { projectId }))!
    .project;
  expect(project.workspaceFileId).toBe(next.fileId);
  expect(project.scanFileId).toBe(scan.fileId);
  await t.mutation(internal.files.expire, { fileId: next.fileId });
  expect(
    await t.run(
      async (ctx) => (await ctx.storage.get(next.storageId)) !== null,
    ),
  ).toBe(true);
  const abandoned = await staged("workspace", "abandoned");
  await t.mutation(internal.files.expire, { fileId: abandoned.fileId });
  expect(await t.run((ctx) => ctx.storage.get(abandoned.storageId))).toBeNull();
});

it("authenticates Clerk deletion events and handles repeated delivery", async () => {
  const { t } = await setup();
  const previousSecret = process.env.CLERK_WEBHOOK_SECRET;
  const previousIssuer = process.env.CLERK_JWT_ISSUER_DOMAIN;
  const secret = `whsec_${Buffer.from("test webhook secret only").toString("base64")}`;
  process.env.CLERK_WEBHOOK_SECRET = secret;
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://identity.example";
  try {
    const body = JSON.stringify({
      type: "user.deleted",
      data: { id: "user_123" },
    });
    const now = new Date();
    const headers = {
      "content-type": "application/json",
      "svix-id": "msg_123",
      "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign("msg_123", now, body),
    };
    expect(
      (
        await t.fetch("/auth/webhook", {
          method: "POST",
          headers,
          body: body.replace("user_123", "attacker"),
        })
      ).status,
    ).toBe(400);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (await t.fetch("/auth/webhook", { method: "POST", headers, body }))
          .status,
      ).toBe(204);
    const rows = await t.run((ctx) =>
      ctx.db.query("accountDeletions").collect(),
    );
    expect(rows.map((row) => row.ownerId)).toEqual([
      "https://identity.example|user_123",
    ]);
  } finally {
    if (previousSecret === undefined) delete process.env.CLERK_WEBHOOK_SECRET;
    else process.env.CLERK_WEBHOOK_SECRET = previousSecret;
    if (previousIssuer === undefined)
      delete process.env.CLERK_JWT_ISSUER_DOMAIN;
    else process.env.CLERK_JWT_ISSUER_DOMAIN = previousIssuer;
  }
});
