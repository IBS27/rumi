import { mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireOwner } from "./ownership";
import type { Id } from "./_generated/dataModel";
import { productSchema } from "../shared/contracts";

async function pinSelections(ctx: MutationCtx, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  const room = project?.roomId && (await ctx.db.get(project.roomId));
  if (!room) return;
  const pin = async (objects: typeof room.snapshot.objects) =>
    Promise.all(
      objects.map(async (object) => {
        if (!object.productId || object.productSnapshot) return object;
        const product = await ctx.db
          .query("products")
          .withIndex("by_catalog_id", (q) => q.eq("id", object.productId!))
          .unique();
        return product
          ? { ...object, productSnapshot: productSchema.parse(product) }
          : object;
      }),
    );
  await ctx.db.patch(room._id, {
    snapshot: { ...room.snapshot, objects: await pin(room.snapshot.objects) },
    history: await Promise.all((room.history ?? []).map(pin)),
  });
}
export const project = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwner(ctx);
    if ((await ctx.db.get(projectId))?.ownerId !== ownerId)
      throw new Error("Project not found.");
    if ((await ctx.db.get(projectId))?.migrationVersion === 1) return;
    await pinSelections(ctx, projectId);
    await ctx.scheduler.runAfter(0, internal.migrations.recommendations, {
      projectId,
      cursor: null,
    });
  },
});
export const recommendations = internalMutation({
  args: { projectId: v.id("projects"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { projectId, cursor }) => {
    if (!(await ctx.db.get(projectId))) return;
    const page = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .paginate({ cursor, numItems: 50 });
    for (const message of page.page) {
      const choices =
        message.recommendations ??
        (message.recommendationProductId
          ? [
              {
                zoneId: message.recommendationProductId,
                productId: message.recommendationProductId,
                fits: "unknown" as const,
                issues: [],
              },
            ]
          : []);
      const plan = choices.length
        ? await ctx.db
            .query("plans")
            .withIndex("by_projectId", (q) =>
              q
                .eq("projectId", projectId)
                .lte("_creationTime", message._creationTime),
            )
            .order("desc")
            .first()
        : null;
      for (const result of choices) {
        const old = await ctx.db
          .query("recommendations")
          .withIndex("by_message_zone", (q) =>
            q.eq("messageId", message._id).eq("result.zoneId", result.zoneId),
          )
          .unique();
        if (old) continue;
        const product = result.productId
          ? await ctx.db
              .query("products")
              .withIndex("by_catalog_id", (q) => q.eq("id", result.productId!))
              .unique()
          : null;
        await ctx.db.insert("recommendations", {
          projectId,
          messageId: message._id,
          zone:
            plan?.plan.zones.find((zone) => zone.id === result.zoneId) ?? null,
          result,
          product: product ? productSchema.parse(product) : null,
          explanation: "Migrated from saved conversation.",
        });
      }
    }
    if (page.isDone) await ctx.db.patch(projectId, { migrationVersion: 1 });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.migrations.recommendations, {
        projectId,
        cursor: page.continueCursor,
      });
  },
});
/** Admin-only Convex dashboard operation; bounded, resumable and safe to rerun. */
export const allProjects = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("projects")
      .paginate({ cursor, numItems: 10 });
    for (const project of page.page) {
      await pinSelections(ctx, project._id);
      await ctx.scheduler.runAfter(0, internal.migrations.recommendations, {
        projectId: project._id,
        cursor: null,
      });
    }
    console.info(
      JSON.stringify({
        event: "migration.projects",
        count: page.page.length,
        done: page.isDone,
      }),
    );
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.migrations.allProjects, {
        cursor: page.continueCursor,
      });
  },
});
