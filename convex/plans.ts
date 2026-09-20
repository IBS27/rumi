import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import {
  internalMutation,
  internalQuery,
  mutation,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { postUserTurn } from "./messages";
import { requireOwner } from "./ownership";
import schema from "./schema";
import { designPlanSchema } from "../shared/contracts";

const planDoc = v.object({
  ...schema.tables.plans.validator.fields,
  _id: v.id("plans"),
  _creationTime: v.number(),
});

async function requireCurrentRoom(ctx: QueryCtx, plan: Doc<"plans">) {
  const project = await ctx.db.get(plan.projectId);
  const room = await ctx.db.get(plan.roomId);
  if (
    project?.roomId !== plan.roomId ||
    !room ||
    room.snapshot.id !== plan.plan.roomId ||
    room.snapshot.revision !== plan.plan.baseRevision
  )
    throw new Error(
      "The room has changed since this plan was made. Request a new plan before searching.",
    );
}

// Store a reserved plan and post the card that lets the user trim it. Any
// earlier open plan for the project is superseded so only one card is live.
export const propose = internalMutation({
  returns: v.id("plans"),
  args: {
    projectId: v.id("projects"),
    roomId: v.id("rooms"),
    plan: zodToConvex(designPlanSchema),
  },
  handler: async (ctx, { projectId, roomId, plan }) => {
    if (!(await ctx.db.get(projectId)))
      throw new Error("This project does not exist.");
    const open = await ctx.db
      .query("plans")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .filter((q) => q.eq(q.field("status"), "proposed"))
      .collect();
    for (const previous of open)
      await ctx.db.patch(previous._id, { status: "superseded" });
    const planId = await ctx.db.insert("plans", {
      projectId,
      roomId,
      plan: designPlanSchema.parse(plan),
      status: "proposed",
      createdAt: Date.now(),
    });
    await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      kind: "plan",
      planId,
      content: plan.summary,
      status: "pending",
      createdAt: Date.now(),
    });
    return planId;
  },
});

export const get = internalQuery({
  returns: v.union(planDoc, v.null()),
  args: { planId: v.id("plans") },
  handler: async (ctx, { planId }): Promise<Doc<"plans"> | null> =>
    await ctx.db.get(planId),
});

// The newest plan the user has confirmed but not yet shopped, or is shopping.
export const active = internalQuery({
  returns: v.union(planDoc, v.null()),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }): Promise<Doc<"plans"> | null> => {
    const plans = await ctx.db
      .query("plans")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(10);
    const activePlan = (
      plans.find(
        (plan) => plan.status === "searching" || plan.status === "proposed",
      ) ?? null
    );
    if (activePlan) await requireCurrentRoom(ctx, activePlan);
    return activePlan;
  },
});

export const setStatus = internalMutation({
  returns: v.null(),
  args: {
    planId: v.id("plans"),
    status: v.union(v.literal("searching"), v.literal("searched")),
  },
  handler: async (ctx, { planId, status }) => {
    await ctx.db.patch(planId, { status });
    return null;
  },
});

// The user kept some zones on the plan card. Record the choice, close the
// card, and post a user turn so the agent searches exactly those zones.
export const confirm = mutation({
  returns: v.id("messages"),
  args: {
    messageId: v.id("messages"),
    zoneIds: v.array(v.string()),
  },
  handler: async (ctx, { messageId, zoneIds }) => {
    const ownerId = await requireOwner(ctx);
    const card = await ctx.db.get(messageId);
    if (!card || card.kind !== "plan" || !card.planId || card.answer)
      throw new Error("This plan card does not exist.");
    const project = await ctx.db.get(card.projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    const plan = await ctx.db.get(card.planId);
    if (!plan || plan.status !== "proposed")
      throw new Error("This plan is no longer open.");
    await requireCurrentRoom(ctx, plan);
    const known = new Set(plan.plan.zones.map((zone) => zone.id));
    const selected = [...new Set(zoneIds)].filter((id) => known.has(id));
    if (selected.length === 0) throw new Error("Keep at least one item.");
    const kept = plan.plan.zones.filter((zone) => selected.includes(zone.id));
    await ctx.db.patch(plan._id, {
      selectedZoneIds: selected,
      status: "searching",
    });
    await ctx.db.patch(messageId, { answer: selected, status: "done" });
    return await postUserTurn(
      ctx,
      card.projectId,
      ownerId,
      `Search these ${kept.length} item${kept.length === 1 ? "" : "s"} from the plan: ${kept
        .map((zone) => zone.category)
        .join(", ")}.`,
    );
  },
});
