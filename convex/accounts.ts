import { mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { deleteProject } from "./projects";
export const requestDeletion = mutation({
  args: {},
  handler: async (ctx) => {
    if (!process.env.CLERK_SECRET_KEY)
      throw new Error("Account deletion is not configured. Contact support.");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    await ctx.runMutation(internal.accounts.beginDeletion, {
      ownerId: identity.tokenIdentifier,
      subject: identity.subject,
    });
  },
});
export const beginDeletion = internalMutation({
  args: { ownerId: v.string(), subject: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query("accountDeletions")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!old)
      await ctx.db.insert("accountDeletions", {
        ...args,
        requestedAt: Date.now(),
        status: "pending",
      });
    await ctx.scheduler.runAfter(0, internal.accounts.cleanup, {
      ownerId: args.ownerId,
    });
  },
});
export const identityResult = internalMutation({
  args: { ownerId: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { ownerId, error }) => {
    const row = await ctx.db
      .query("accountDeletions")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (row)
      await ctx.db.patch(row._id, {
        status: error ? "identity-pending" : "done",
        error,
      });
  },
});

export const cleanup = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(25);
    for (const project of projects) await deleteProject(ctx, project);
    const captures = await ctx.db
      .query("captures")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(25);
    for (const capture of captures) {
      for (const id of new Set([capture.storageId, capture.scanStorageId]))
        if (id) await ctx.storage.delete(id);
      const chunks = await ctx.db
        .query("captureChunks")
        .withIndex("by_capture_index", (q) => q.eq("captureId", capture._id))
        .collect();
      for (const chunk of chunks) {
        await ctx.storage.delete(chunk.storageId);
        await ctx.db.delete(chunk._id);
      }
      await ctx.db.delete(capture._id);
    }
    const jobs = await ctx.db
      .query("roomReconstructions")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(25);
    for (const job of jobs) {
      for (const id of [
        job.inputId,
        job.planId,
        ...(job.batches ?? []).map((batch) => batch.storageId),
      ])
        if (id) await ctx.storage.delete(id);
      await ctx.db.delete(job._id);
    }
    let more =
      projects.length === 25 || captures.length === 25 || jobs.length === 25;
    for (const table of ["rooms", "proposals"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(25);
      for (const row of rows) await ctx.db.delete(row._id);
      more ||= rows.length === 25;
    }
    if (more)
      await ctx.scheduler.runAfter(0, internal.accounts.cleanup, { ownerId });
    else {
      const row = await ctx.db
        .query("accountDeletions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (row?.subject) {
        await ctx.db.patch(row._id, { status: "identity-pending" });
        await ctx.scheduler.runAfter(0, internal.accountJobs.deleteIdentity, {
          ownerId,
          subject: row.subject,
          attempt: 0,
        });
      } else if (row) await ctx.db.patch(row._id, { status: "done" });
    }
  },
});
