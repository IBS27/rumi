import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Dashboard/admin API only. Recovery is explicit because backups omit scheduled functions. */
export const recover = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("projects")
      .paginate({ cursor, numItems: 25 });
    let count = 0;
    for (const project of page.page) {
      if (!project.activeMessageId) continue;
      const message = await ctx.db.get(project.activeMessageId);
      if (message?.status === "pending") {
        await ctx.scheduler.runAfter(0, internal.agent.runForProject, {
          projectId: project._id,
          messageId: message._id,
        });
        await ctx.scheduler.runAfter(180000, internal.messages.expire, {
          messageId: message._id,
        });
        count++;
      } else await ctx.db.patch(project._id, { activeMessageId: undefined });
    }
    await ctx.db.insert("operatorEvents", {
      operation: "restore-agent-schedules",
      count,
      createdAt: Date.now(),
    });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.operations.recover, {
        cursor: page.continueCursor,
      });
  },
});
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").take(1000);
    const deletions = await ctx.db.query("accountDeletions").take(100);
    return {
      sampledProjects: projects.length,
      activeTurns: projects
        .filter((project) => project.activeMessageId)
        .map((project) => ({
          projectId: project._id,
          messageId: project.activeMessageId,
        })),
      pendingDeletions: deletions
        .filter((row) => row.status !== "done")
        .map((row) => ({ id: row._id, status: row.status, error: row.error })),
    };
  },
});
