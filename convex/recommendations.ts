import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireTurn } from "./turns";
import schema from "./schema";
export const forZone = internalQuery({
  args: { planId: v.id("plans"), zoneId: v.string() },
  handler: (ctx, { planId, zoneId }) =>
    ctx.db
      .query("recommendations")
      .withIndex("by_plan_zone", (q) =>
        q.eq("planId", planId).eq("result.zoneId", zoneId),
      )
      .unique(),
});
export const save = internalMutation({
  args: {
    ...schema.tables.recommendations.validator.fields,
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { attempt, ...args }) => {
    await requireTurn(ctx, args.projectId, args.messageId, attempt);
    const sameTurn = await ctx.db
      .query("recommendations")
      .withIndex("by_message_zone", (q) =>
        q
          .eq("messageId", args.messageId)
          .eq("result.zoneId", args.result.zoneId),
      )
      .unique();
    if (sameTurn?.product) return sameTurn._id;
    if (args.planId) {
      const plan = await ctx.db.get(args.planId);
      const room = plan && (await ctx.db.get(plan.roomId));
      if (
        !plan ||
        plan.projectId !== args.projectId ||
        plan.status === "superseded" ||
        room?.snapshot.revision !== plan.plan.baseRevision
      )
        throw new Error("The plan changed during search.");
      const old = await ctx.db
        .query("recommendations")
        .withIndex("by_plan_zone", (q) =>
          q.eq("planId", args.planId).eq("result.zoneId", args.result.zoneId),
        )
        .unique();
      if (old?.product) return old._id;
      if (old) {
        await ctx.db.replace(old._id, args);
        return old._id;
      }
    }
    if (sameTurn) {
      await ctx.db.replace(sameTurn._id, args);
      return sameTurn._id;
    }
    return ctx.db.insert("recommendations", args);
  },
});
