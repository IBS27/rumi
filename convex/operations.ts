import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, TableNames } from "./_generated/dataModel";
import { v } from "convex/values";
import { MAX_RECONSTRUCTION_MS } from "../shared/reconstruction/contracts";

const DAY = 24 * 60 * 60 * 1000;
const at = (time: number) => Math.max(0, time - Date.now());

/**
 * Backups omit scheduled functions, so a restored deployment loses every pending
 * timer, cleanup batch and agent step. Each phase re-arms one table's lifecycle.
 * The scheduled handlers all recheck state, so rerunning recovery is safe.
 */
const phases = [
  "projects",
  "projectDeletions",
  "accountDeletions",
  "files",
  "fileTickets",
  "imageUploads",
  "captures",
  "assets",
  "roomReconstructions",
] as const;

async function sweep<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  cursor: string | null,
  recover: (doc: Doc<T>) => Promise<boolean>,
) {
  const page = await ctx.db.query(table).paginate({ cursor, numItems: 25 });
  let count = 0;
  for (const doc of page.page) if (await recover(doc)) count++;
  await ctx.db.insert("operatorEvents", {
    operation: `recover:${table}`,
    count,
    createdAt: Date.now(),
  });
  return page.isDone ? null : page.continueCursor;
}

async function resumeReply(ctx: MutationCtx, project: Doc<"projects">) {
  const message = project.activeMessageId
    ? await ctx.db.get(project.activeMessageId)
    : null;
  if (message?.status !== "pending") {
    await ctx.db.patch(project._id, { activeMessageId: undefined });
    return false;
  }
  // A new attempt fences any chain still running from before recovery.
  const attempt = (message.runAttempt ?? 0) + 1;
  await ctx.db.patch(message._id, { runAttempt: attempt });
  await ctx.scheduler.runAfter(180000, internal.messages.expire, {
    messageId: message._id,
  });
  const user = (
    await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(100)
  ).find((item) => item.role === "user");
  const image = user?.imageId ? await ctx.db.get(user.imageId) : null;
  if (user && image?.status === "pending")
    await ctx.scheduler.runAfter(0, internal.images.analyze, {
      imageId: image._id,
      userMessageId: user._id,
      assistantMessageId: message._id,
      attempt,
    });
  else
    await ctx.scheduler.runAfter(0, internal.agent.runForProject, {
      projectId: project._id,
      messageId: message._id,
      attempt,
    });
  return true;
}

/** Dashboard/admin API only. Run once after restoring into an isolated deployment. */
export const recover = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    phase: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, phase = 0 }) => {
    let next: string | null;
    switch (phases[phase]) {
      case "projects":
        next = await sweep(ctx, "projects", cursor, async (project) =>
          project.activeMessageId ? resumeReply(ctx, project) : false,
        );
        break;
      case "projectDeletions":
        next = await sweep(ctx, "projectDeletions", cursor, async (row) => {
          await ctx.scheduler.runAfter(0, internal.projects.cleanup, {
            projectId: row.projectId,
          });
          return true;
        });
        break;
      case "accountDeletions":
        next = await sweep(ctx, "accountDeletions", cursor, async (row) => {
          if (row.status === "pending")
            await ctx.scheduler.runAfter(0, internal.accounts.cleanup, {
              ownerId: row.ownerId,
            });
          else if (row.status === "identity-pending" && row.subject)
            await ctx.scheduler.runAfter(
              0,
              internal.accountJobs.deleteIdentity,
              {
                ownerId: row.ownerId,
                subject: row.subject,
                attempt: 0,
              },
            );
          else return false;
          return true;
        });
        break;
      case "files":
        next = await sweep(ctx, "files", cursor, async (file) => {
          const project = await ctx.db.get(file.projectId);
          if (
            project?.workspaceFileId === file._id ||
            project?.scanFileId === file._id
          )
            return false;
          await ctx.scheduler.runAfter(
            at(file.expiresAt),
            internal.files.expire,
            {
              fileId: file._id,
            },
          );
          return true;
        });
        break;
      case "fileTickets":
        next = await sweep(ctx, "fileTickets", cursor, async (ticket) => {
          await ctx.scheduler.runAfter(
            at(ticket.expiresAt),
            internal.files.expireTicket,
            {
              id: ticket._id,
            },
          );
          return true;
        });
        break;
      case "imageUploads":
        next = await sweep(ctx, "imageUploads", cursor, async (upload) => {
          await ctx.scheduler.runAfter(
            at(upload.expiresAt),
            internal.images.expireUpload,
            {
              uploadId: upload._id,
            },
          );
          return true;
        });
        break;
      case "captures":
        next = await sweep(ctx, "captures", cursor, async (capture) => {
          await ctx.scheduler.runAfter(
            at(capture._creationTime + DAY),
            internal.captures.removeExpired,
            { sessionId: capture._id },
          );
          return true;
        });
        break;
      case "assets":
        next = await sweep(ctx, "assets", cursor, async (asset) => {
          // Pending rows without an attempt predate generation jobs; retry replaces them.
          if (asset.status !== "pending" || asset.attempt === undefined)
            return false;
          await ctx.scheduler.runAfter(
            at((asset.updatedAt ?? 0) + 300000),
            internal.assets.expire,
            { id: asset.id, attempt: asset.attempt },
          );
          return true;
        });
        break;
      case "roomReconstructions":
        next = await sweep(ctx, "roomReconstructions", cursor, async (job) => {
          if (job.stage === "ready" || job.stage === "failed") return false;
          // Its worker is gone. Failing it lets the owner retry from saved batches.
          await ctx.scheduler.runAfter(
            MAX_RECONSTRUCTION_MS + 30_000,
            internal.roomReconstruction.expire,
            {
              id: job._id,
              attempt: job.attempt,
              step: job.step,
            },
          );
          return true;
        });
        break;
      default:
        return;
    }
    if (next || phase + 1 < phases.length)
      await ctx.scheduler.runAfter(0, internal.operations.recover, {
        cursor: next,
        phase: next ? phase : phase + 1,
      });
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").take(1000);
    const deletions = await ctx.db.query("accountDeletions").take(100);
    const projectDeletions = await ctx.db.query("projectDeletions").take(100);
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
      pendingProjectCleanups: projectDeletions.map((row) => ({
        projectId: row.projectId,
        requestedAt: row.requestedAt,
      })),
    };
  },
});
