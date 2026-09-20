import { appendHistory } from "../shared/design/history";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwner } from "./ownership";
import { normalizeBrief } from "./projects";
import {
  assetSchema,
  productSchema,
  roomSchema,
  type ProductCandidate,
  type RoomSnapshot,
  type ReservedZone,
} from "../shared/contracts";
import {
  applyDesignCommands,
  commandProductIds,
  designCommandsSchema,
  type DesignCommand,
} from "../shared/design";
import { designStateSchema, type DesignState } from "../shared/design/state";
import { queueProductAsset } from "./assets";
import { selectionTotal } from "../shared/budget";
import { sampleProducts } from "../shared/fixtures";

async function ownedRoom(ctx: QueryCtx, projectId: Id<"projects">) {
  const ownerId = await requireOwner(ctx);
  const project = await ctx.db.get(projectId);
  if (!project || project.ownerId !== ownerId || !project.roomId)
    throw new Error("Attach a room to this conversation first.");
  const room = await ctx.db.get(project.roomId);
  if (!room || room.ownerId !== ownerId)
    throw new Error("This room is no longer available.");
  return room;
}

export async function catalogProducts(
  ctx: QueryCtx,
  ids: string[],
): Promise<ProductCandidate[]> {
  const docs = await Promise.all(
    [...new Set(ids)].map((id) =>
      ctx.db
        .query("products")
        .withIndex("by_catalog_id", (q) => q.eq("id", id))
        .unique(),
    ),
  );
  return docs.flatMap((doc) => (doc ? [productSchema.parse(doc)] : []));
}

export async function commitDesign(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  expectedRevision: number,
  commands: DesignCommand[],
  actor: "user" | "agent",
  maxTotalCents?: number,
): Promise<RoomSnapshot> {
  const doc = await ctx.db.get(roomId);
  if (!doc) throw new Error("This room is no longer available.");
  if (doc.snapshot.revision !== expectedRevision)
    throw new Error(
      "The room changed. Your edit was not applied. Review the latest layout and try again.",
    );
  const parsed = designCommandsSchema.parse(commands);
  const products = await catalogProducts(
    ctx,
    commandProductIds(doc.snapshot, parsed),
  );
  const next = applyDesignCommands(
    doc.snapshot,
    parsed,
    products,
    normalizeBrief(doc.brief),
    actor,
  );
  if (
    maxTotalCents !== undefined &&
    selectionTotal(next, products) > maxTotalCents
  )
    throw new Error(
      "These changes do not meet the requested savings target. Choose cheaper replacements.",
    );
  await ctx.db.patch(roomId, {
    snapshot: next,
    history: appendHistory(doc.history ?? [], doc.snapshot.objects),
  });
  for (const id of new Set(
    parsed.flatMap((command) =>
      command.type === "add" || command.type === "replace"
        ? [command.productId]
        : [],
    ),
  )) {
    const product = products.find((item) => item.id === id)!;
    await queueProductAsset(ctx, product);
  }
  return next;
}

export const edit = mutation({
  args: {
    projectId: v.id("projects"),
    expectedRevision: v.number(),
    commands: zodToConvex(designCommandsSchema),
  },
  returns: zodToConvex(roomSchema),
  handler: async (
    ctx,
    { projectId, expectedRevision, commands },
  ): Promise<RoomSnapshot> => {
    const room = await ownedRoom(ctx, projectId);
    return commitDesign(ctx, room._id, expectedRevision, commands, "user");
  },
});

export const editByAgent = internalMutation({
  args: {
    projectId: v.id("projects"),
    expectedRevision: v.number(),
    commands: zodToConvex(designCommandsSchema),
    messageId: v.id("messages"),
    maxTotalCents: v.optional(v.number()),
  },
  returns: zodToConvex(roomSchema),
  handler: async (
    ctx,
    { projectId, expectedRevision, commands, messageId, maxTotalCents },
  ): Promise<RoomSnapshot> => {
    const project = await ctx.db.get(projectId);
    if (!project?.roomId || project.activeMessageId !== messageId)
      throw new Error("This design turn is no longer active.");
    return commitDesign(
      ctx,
      project.roomId,
      expectedRevision,
      commands,
      "agent",
      maxTotalCents,
    );
  },
});

export const undo = mutation({
  args: { projectId: v.id("projects"), expectedRevision: v.number() },
  returns: zodToConvex(roomSchema),
  handler: async (
    ctx,
    { projectId, expectedRevision },
  ): Promise<RoomSnapshot> => {
    const room = await ownedRoom(ctx, projectId);
    if (room.snapshot.revision !== expectedRevision)
      throw new Error(
        "The room changed. Review the latest layout before undoing.",
      );
    const history = room.history ?? [];
    if (!history.length) throw new Error("There is no design change to undo.");
    const next = roomSchema.parse({
      ...room.snapshot,
      objects: history[history.length - 1],
      revision: room.snapshot.revision + 1,
    });
    const products = await catalogProducts(
      ctx,
      next.objects.flatMap((item) => (item.productId ? [item.productId] : [])),
    );
    const brief = normalizeBrief(room.brief);
    if (
      brief.budgetCents > 0 &&
      selectionTotal(next, products) > brief.budgetCents
    )
      throw new Error(
        "Restoring this design would exceed your current budget.",
      );
    await ctx.db.patch(room._id, {
      snapshot: next,
      history: history.slice(0, -1),
    });
    return next;
  },
});

export const retryAsset = mutation({
  args: { projectId: v.id("projects"), productId: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, productId }) => {
    const room = await ownedRoom(ctx, projectId);
    if (!room.snapshot.objects.some((item) => item.productId === productId))
      throw new Error("Only products in this room can be modeled.");
    const [product] = await catalogProducts(ctx, [productId]);
    if (!product) throw new Error("This product is no longer available.");
    await queueProductAsset(ctx, product, true);
    return null;
  },
});

async function readDesign(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<DesignState | null> {
  const project = await ctx.db.get(projectId);
  if (!project?.roomId) return null;
  const ownerId = project.ownerId;
  const room = await ctx.db.get(project.roomId);
  if (!room || room.ownerId !== ownerId) return null;
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .order("desc")
    .take(30);
  const plans = await ctx.db
    .query("plans")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .order("desc")
    .take(10);
  const choices = new Map<
    string,
    { productId: string; zone: ReservedZone | null }
  >();
  for (const message of messages) {
    for (const choice of message.recommendations ?? []) {
      if (!choice.productId || choices.size >= 24) continue;
      const key = `${choice.zoneId}:${choice.productId}`;
      const plan = plans.find(
        (item) =>
          item.plan.roomId === room.snapshot.id &&
          item.createdAt <= message.createdAt &&
          item.plan.zones.some((zone) => zone.id === choice.zoneId),
      );
      if (!choices.has(key))
        choices.set(key, {
          productId: choice.productId,
          zone:
            plan?.plan.zones.find((zone) => zone.id === choice.zoneId) ?? null,
        });
    }
    if (
      message.recommendationProductId &&
      choices.size < 24 &&
      ![...choices.values()].some(
        (choice) => choice.productId === message.recommendationProductId,
      )
    )
      choices.set(message.recommendationProductId, {
        productId: message.recommendationProductId,
        zone: null,
      });
    if (choices.size >= 24) break;
  }
  if (
    !choices.size &&
    room.snapshot.shape === "polygon" &&
    room.snapshot.capture.synthetic
  )
    for (const product of sampleProducts)
      choices.set(product.id, { productId: product.id, zone: null });
  const products = await catalogProducts(ctx, [
    ...[...choices.values()].map((choice) => choice.productId),
    ...room.snapshot.objects.flatMap((object) =>
      object.productId ? [object.productId] : [],
    ),
  ]);
  const recommendations = [...choices.values()].flatMap((choice) => {
    const product = products.find((item) => item.id === choice.productId);
    return product?.measurement.dimensions
      ? [{ product, zone: choice.zone }]
      : [];
  });
  const assetIds = [
    ...new Set(
      room.snapshot.objects.flatMap((object) =>
        object.productId
          ? [
              products.find((product) => product.id === object.productId)
                ?.assetId ??
                object.assetId ??
                `${object.productId}-asset`,
            ]
          : object.assetId
            ? [object.assetId]
            : [],
      ),
    ),
  ];
  const assets = (
    await Promise.all(
      assetIds.map((id) =>
        ctx.db
          .query("assets")
          .withIndex("by_catalog_id", (q) => q.eq("id", id))
          .unique(),
      ),
    )
  ).flatMap((asset) => (asset ? [assetSchema.parse(asset)] : []));
  return {
    room: room.snapshot,
    brief: normalizeBrief(room.brief),
    products,
    assets,
    recommendations,
    canUndo: Boolean(room.history?.length),
  };
}

export const get = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), zodToConvex(designStateSchema)),
  handler: async (ctx, { projectId }): Promise<DesignState | null> => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId) return null;
    return readDesign(ctx, projectId);
  },
});
export const getForAgent = internalQuery({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), zodToConvex(designStateSchema)),
  handler: (ctx, { projectId }): Promise<DesignState | null> =>
    readDesign(ctx, projectId),
});
