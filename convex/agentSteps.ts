import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requireTurn } from "./turns";
import schema from "./schema";
const fields = schema.tables.agentSteps.validator.fields;
export const list = internalQuery({
  args: { messageId: v.id("messages") },
  handler: (ctx, { messageId }) =>
    ctx.db
      .query("agentSteps")
      .withIndex("by_message_step", (q) => q.eq("messageId", messageId))
      .collect(),
});
// The model's tool calls are committed before any side effects execute.
export const save = internalMutation({
  args: fields,
  handler: async (ctx, args) => {
    await requireTurn(ctx, args.projectId, args.messageId);
    const existing = await ctx.db
      .query("agentSteps")
      .withIndex("by_message_step", (q) =>
        q.eq("messageId", args.messageId).eq("step", args.step),
      )
      .unique();
    if (existing) return existing._id;
    return ctx.db.insert("agentSteps", args);
  },
});
export const output = internalMutation({
  args: { id: v.id("agentSteps"), callId: v.string(), output: v.string() },
  handler: async (ctx, { id, callId, output }) => {
    const step = await ctx.db.get(id);
    if (!step) throw new Error("Step was deleted.");
    await requireTurn(ctx, step.projectId, step.messageId);
    const outputs: Record<string, unknown> = JSON.parse(step.outputs);
    if (!(callId in outputs)) outputs[callId] = JSON.parse(output);
    await ctx.db.patch(id, { outputs: JSON.stringify(outputs) });
  },
});
