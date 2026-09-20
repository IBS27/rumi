import { describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { sampleProducts } from "../shared/fixtures";
import { sampleDesignAssets } from "../shared/fixtures/design";
import { importRoomPlan } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { selectionTotal } from "../shared/budget";
import type { DesignCommand } from "../shared/design";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/design.ts": () => import("../convex/design"),
  "../convex/products.ts": () => import("../convex/products"),
  "../convex/assets.ts": () => import("../convex/assets"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
  const other = t.withIdentity({ tokenIdentifier: "test|other" });
  const room = importRoomPlan(syntheticRoomPlan, "Demo room", true);
  const projectId = await owner.mutation(api.projects.create, {
    title: "Demo",
    room,
  });
  await t.mutation(internal.projects.updateBrief, {
    projectId,
    budgetCents: 50000,
  });
  const edit = (expectedRevision: number, commands: DesignCommand[]) =>
    owner.mutation(api.design.edit, { projectId, expectedRevision, commands });
  return { t, owner, other, projectId, room, edit };
}
const add = (index = 0, instanceId = "lamp"): DesignCommand => ({
  type: "add",
  productId: sampleProducts[index].id,
  instanceId,
});

describe("authoritative room editing", () => {
  it("saves inspector locks on catalog products after database serialization", async () => {
    const { edit } = await setup();
    const room = await edit(0, [add()]);
    const lamp = room.objects.find((object) => object.id === "lamp")!;
    const next = await edit(1, [
      {
        type: "correct",
        object: { ...lamp, productLocked: true, locked: true },
      },
    ]);
    expect(
      next.objects.find((object) => object.id === "lamp")?.productLocked,
    ).toBe(true);
    expect(
      next.objects.find((object) => object.id === "lamp")?.position,
    ).toEqual(lamp.position);
  });
  it("checks ownership and exposes the same room, selection and models together", async () => {
    const { t, owner, other, projectId, edit } = await setup();
    await expect(t.query(api.design.get, { projectId })).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    expect(await other.query(api.design.get, { projectId })).toBeNull();
    await expect(
      other.mutation(api.design.edit, {
        projectId,
        expectedRevision: 0,
        commands: [add()],
      }),
    ).rejects.toThrow();
    const room = await edit(0, [add()]);
    const state = await owner.query(api.design.get, { projectId });
    expect(state?.room).toEqual(room);
    expect(selectionTotal(room, state!.products)).toBe(7900);
    expect(state?.assets[0].status).toBe("ready");
    expect(state?.canUndo).toBe(true);
  });

  it("rejects stale edits and attachment overwrites, and undoes without rolling back the revision", async () => {
    const { owner, projectId, edit, room } = await setup();
    await edit(0, [add()]);
    await expect(edit(0, [add(1, "rug")])).rejects.toThrow("room changed");
    await expect(
      owner.mutation(api.projects.attachRoom, {
        projectId,
        room,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("overwrite");
    const next = await edit(1, [add(1, "rug")]);
    expect(next.objects.filter((o) => o.productId).length).toBe(2);
    const undone = await owner.mutation(api.design.undo, {
      projectId,
      expectedRevision: 2,
    });
    expect(undone.revision).toBe(3);
    expect(undone.objects.filter((o) => o.productId).map((o) => o.id)).toEqual([
      "lamp",
    ]);
    await expect(edit(2, [add(1, "rug")])).rejects.toThrow("room changed");
  });

  it("keeps the selected lamp while an atomic agent redesign saves $80", async () => {
    const { t, owner, projectId, edit } = await setup();
    const initial = await edit(
      0,
      sampleProducts.map((_, i) => add(i, i === 0 ? "lamp" : `item-${i}`)),
    );
    const cheaper = {
      ...sampleProducts[1],
      id: "warm-rug",
      color: "#c3a27c",
      priceCents: sampleProducts[1].priceCents - 8000,
    };
    await t.mutation(internal.products.upsertProducts, { products: [cheaper] });
    const reply = await owner.mutation(api.messages.send, {
      projectId,
      content: "Keep this lamp, make the room warmer, and save $80.",
      selectedObjectId: "lamp",
    });
    expect((await t.run((ctx) => ctx.db.get(reply)))?.selectedObjectId).toBe(
      "lamp",
    );
    const commands: DesignCommand[] = [
      {
        type: "lock",
        objectId: "lamp",
        productLocked: true,
        placementLocked: false,
      },
      { type: "replace", objectId: "item-1", productId: cheaper.id },
    ];
    await expect(
      t.mutation(internal.design.editByAgent, {
        projectId,
        messageId: reply,
        expectedRevision: 1,
        commands,
        maxTotalCents: 31500,
      }),
    ).rejects.toThrow("savings");
    expect((await owner.query(api.design.get, { projectId }))?.room).toEqual(
      initial,
    );
    const updated = await t.mutation(internal.design.editByAgent, {
      projectId,
      messageId: reply,
      expectedRevision: 1,
      commands,
      maxTotalCents: 31600,
    });
    expect(selectionTotal(updated, [...sampleProducts, cheaper])).toBe(31600);
    expect(updated.objects.find((o) => o.id === "lamp")).toEqual({
      ...initial.objects.find((o) => o.id === "lamp")!,
      productLocked: true,
    });
    expect(updated.objects.find((o) => o.id === "item-1")?.color).toBe(
      cheaper.color,
    );
    await expect(
      t.mutation(internal.design.editByAgent, {
        projectId,
        messageId: reply,
        expectedRevision: 2,
        commands: [{ type: "remove", objectId: "lamp" }],
      }),
    ).rejects.toThrow("kept");
    await t.mutation(internal.messages.complete, {
      messageId: reply,
      content: "Saved $80.",
      status: "done",
    });
    await expect(
      t.mutation(internal.design.editByAgent, {
        projectId,
        messageId: reply,
        expectedRevision: 2,
        commands,
      }),
    ).rejects.toThrow("no longer active");
  });

  it("rejects collisions atomically and checks the existing selection in subsequent budget edits", async () => {
    const { owner, projectId, edit } = await setup();
    const room = await edit(0, [add()]);
    await expect(
      edit(1, [
        add(1, "rug"),
        {
          type: "move",
          objectId: "lamp",
          position: { x: 1, y: 0, z: 4.2 },
          rotationY: 0,
        },
      ]),
    ).rejects.toThrow("doorway");
    expect((await owner.query(api.design.get, { projectId }))?.room).toEqual(
      room,
    );
    await edit(1, [add(1, "rug"), add(2, "cabinet"), add(3, "art")]);
    await expect(edit(2, [add(1, "rug2")])).rejects.toThrow("budget");
    expect(
      selectionTotal(
        (await owner.query(api.design.get, { projectId }))!.room,
        sampleProducts,
      ),
    ).toBe(39600);
  });

  it("deduplicates model jobs, allows retry and ignores late completions", async () => {
    const { t, owner, projectId, edit } = await setup();
    const real = {
      ...sampleProducts[0],
      id: "real-lamp",
      assetId: null,
      synthetic: false,
      images: ["https://example.com/lamp.jpg"],
    };
    await t.mutation(internal.products.upsertProducts, { products: [real] });
    await edit(0, [{ type: "add", productId: real.id, instanceId: "real" }]);
    const id = "real-lamp-asset";
    const pending = await t.query(internal.assets.getByCatalogId, { id });
    expect(pending?.status).toBe("pending");
    await owner.mutation(api.design.retryAsset, {
      projectId,
      productId: real.id,
    });
    expect(
      (await t.query(internal.assets.getByCatalogId, { id }))?.attempt,
    ).toBe(1);
    await t.mutation(internal.assets.expire, { id, attempt: 1 });
    await owner.mutation(api.design.retryAsset, {
      projectId,
      productId: real.id,
    });
    expect(
      (await t.query(internal.assets.getByCatalogId, { id }))?.attempt,
    ).toBe(2);
    const ready = { ...sampleDesignAssets[0], id, attempt: 1 };
    await t.mutation(internal.assets.finish, { asset: ready, attempt: 1 });
    expect(
      (await t.query(internal.assets.getByCatalogId, { id }))?.status,
    ).toBe("pending");
    await t.mutation(internal.assets.finish, {
      asset: { ...ready, attempt: 2 },
      attempt: 2,
    });
    await t.mutation(internal.assets.expire, { id, attempt: 2 });
    expect(
      (await owner.query(api.design.get, { projectId }))?.assets[0].status,
    ).toBe("ready");
    await expect(
      owner.mutation(api.design.retryAsset, {
        projectId,
        productId: sampleProducts[1].id,
      }),
    ).rejects.toThrow("Only products");
  });
});

it("hides old unsized recommendations from chat and the design panel", async () => {
  const { t, owner, projectId } = await setup();
  const unknownProduct = {
    ...sampleProducts[0],
    id: "unsized-plant",
    name: "Unsized plant",
    measurement: {
      dimensions: null,
      source: "unknown" as const,
      evidence: { kind: "none" as const, detail: null },
    },
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("products", unknownProduct);
    await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: "",
      status: "done",
      createdAt: Date.now(),
      recommendationProductId: unknownProduct.id,
      recommendations: [
        {
          zoneId: "plant-zone",
          productId: unknownProduct.id,
          fits: "unknown",
          issues: [],
        },
      ],
    });
  });
  const chat = await owner.query(api.messages.list, {
    projectId,
    paginationOpts: { numItems: 20, cursor: null },
  });
  expect(chat.page[0].recommendation).toBeNull();
  expect(chat.page[0].zoneCards[0].product).toBeNull();
  const design = await owner.query(api.design.get, { projectId });
  expect(design?.recommendations).toEqual([]);
});
