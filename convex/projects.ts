import { v } from "convex/values";
import { internal } from "./_generated/api";
import { postUserTurn } from "./messages";
import { requireOwner } from "./ownership";
import { ensureSampleDesign } from "./sampleDesign";
import schema from "./schema";
import { zodToConvex } from "convex-helpers/server/zod4";
import { paginationOptsValidator } from "convex/server";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { z } from "zod";
import {
  roomSchema,
  briefSchema,
  projectPhaseSchema,
  specTopicSchema,
  wantSchema,
  type DesignBrief,
} from "../shared/contracts";
import { inferBriefPurpose } from "../shared/chat/purpose";

const projectDoc = v.object({
  ...schema.tables.projects.validator.fields,
  _id: v.id("projects"),
  _creationTime: v.number(),
});

export const list = query({
  returns: v.object({
    page: v.array(projectDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const ownerId = await requireOwner(ctx);
    return await ctx.db
      .query("projects")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const rename = mutation({
  returns: v.null(),
  args: {
    projectId: v.id("projects"),
    title: v.string(),
  },
  handler: async (ctx, { projectId, title }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    const nextTitle = title.trim();
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (!nextTitle) throw new Error("A chat title is required.");
    await ctx.db.patch(projectId, { title: nextTitle.slice(0, 80) });
  },
});

export const remove = mutation({
  returns: v.null(),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (project.roomId) await ctx.db.delete(project.roomId);
    await ctx.db.delete(projectId);
    await ctx.scheduler.runAfter(0, internal.projects.cleanup, { projectId });
  },
});

// Delete children in bounded batches after making the project inaccessible.
export const cleanup = internalMutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .take(100);
    const images = await ctx.db
      .query("images")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .take(100);
    for (const message of messages) await ctx.db.delete(message._id);
    for (const image of images) {
      await ctx.storage.delete(image.storageId);
      await ctx.db.delete(image._id);
    }
    if (messages.length === 100 || images.length === 100)
      await ctx.scheduler.runAfter(0, internal.projects.cleanup, { projectId });
  },
});

export const get = internalQuery({
  returns: v.union(projectDoc, v.null()),
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => await ctx.db.get(projectId),
});

export const create = mutation({
  returns: v.id("projects"),
  args: {
    title: v.string(),
    room: v.optional(zodToConvex(roomSchema)),
    firstMessage: v.optional(v.string()),
    selectedObjectId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { title, room, firstMessage, selectedObjectId },
  ): Promise<Id<"projects">> => {
    const ownerId = await requireOwner(ctx);
    title = title.trim().slice(0, 80);
    if (!title) throw new Error("A project title is required.");
    const brief = inferBriefPurpose(
      emptyBrief(),
      firstMessage ?? "",
      room ?? null,
    );
    if (room?.shape === "polygon" && room.capture.synthetic)
      await ensureSampleDesign(ctx);
    const roomId = room
      ? await ctx.db.insert("rooms", {
          ownerId,
          snapshot: roomSchema.parse(room),
          brief,
        })
      : undefined;
    const projectId = await ctx.db.insert("projects", {
      ownerId,
      title,
      roomId,
      brief,
      createdAt: Date.now(),
    });
    if (firstMessage !== undefined)
      await postUserTurn(
        ctx,
        projectId,
        ownerId,
        firstMessage,
        selectedObjectId,
      );
    return projectId;
  },
});

// Stored briefs may predate the Spec fields; parsing fills their defaults.
export function normalizeBrief(brief: Partial<DesignBrief>): DesignBrief {
  const parsed = briefSchema.parse({ ...emptyBrief(), ...brief });
  return parsed.budgetCents >= Number.MAX_SAFE_INTEGER / 2
    ? { ...parsed, budgetCents: 0 }
    : parsed;
}

export function emptyBrief() {
  return briefSchema.parse({
    prompt: "",
    styles: [],
    budgetCents: 0,
    currency: "USD",
    restrictions: [],
  });
}

export const context = query({
  args: { projectId: v.id("projects") },
  returns: v.union(
    v.null(),
    v.object({
      project: projectDoc,
      room: v.union(zodToConvex(roomSchema), v.null()),
      brief: zodToConvex(briefSchema),
      phase: zodToConvex(projectPhaseSchema),
    }),
  ),
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId) return null;
    const room = project.roomId ? await ctx.db.get(project.roomId) : null;
    return {
      project,
      room: room?.snapshot ?? null,
      brief: normalizeBrief(room?.brief ?? project.brief ?? emptyBrief()),
      phase: project.phase ?? "spec",
    };
  },
});

export const attachRoom = mutation({
  args: {
    projectId: v.id("projects"),
    room: zodToConvex(roomSchema),
    expectedRevision: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, room, expectedRevision }) => {
    const ownerId = await requireOwner(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== ownerId)
      throw new Error("This project does not exist.");
    if (project.activeMessageId)
      throw new Error("Wait for the current reply before updating the room.");
    const snapshot = roomSchema.parse(room);
    const existing = project.roomId ? await ctx.db.get(project.roomId) : null;
    if ((existing?.snapshot.revision ?? null) !== expectedRevision)
      throw new Error("The chat room changed. Refresh before updating it.");
    if (
      existing?.snapshot.id === snapshot.id &&
      JSON.stringify(roomSchema.parse(existing.snapshot).objects) !==
        JSON.stringify(snapshot.objects)
    )
      throw new Error(
        "Use the room editor to change this design. Attaching an older snapshot would overwrite saved edits.",
      );
    if (snapshot.shape === "polygon" && snapshot.capture.synthetic)
      await ensureSampleDesign(ctx);
    if (existing) {
      await ctx.db.patch(existing._id, {
        snapshot: { ...snapshot, revision: existing.snapshot.revision + 1 },
        history: [],
      });
    } else {
      const roomId = await ctx.db.insert("rooms", {
        ownerId,
        snapshot,
        brief: project.brief ?? emptyBrief(),
      });
      await ctx.db.patch(projectId, { roomId });
    }
  },
});

export const setPhase = internalMutation({
  args: {
    projectId: v.id("projects"),
    phase: zodToConvex(projectPhaseSchema),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, phase }) => {
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("This project does not exist.");
    await ctx.db.patch(projectId, { phase });
    return null;
  },
});

export const updateBrief = internalMutation({
  args: {
    projectId: v.id("projects"),
    prompt: v.optional(v.string()),
    styles: v.optional(v.array(v.string())),
    budgetCents: v.optional(v.number()),
    restrictions: v.optional(v.array(v.string())),
    palette: v.optional(v.array(v.string())),
    materials: v.optional(v.array(v.string())),
    purpose: v.optional(v.string()),
    wants: v.optional(zodToConvex(z.array(wantSchema))),
    accessories: v.optional(
      v.union(
        v.literal("unspecified"),
        v.literal("include"),
        v.literal("skip"),
      ),
    ),
    inspiration: v.optional(v.string()),
    decided: v.optional(zodToConvex(z.array(specTopicSchema))),
  },
  returns: zodToConvex(briefSchema),
  handler: async (ctx, { projectId, ...patch }) => {
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("This project does not exist.");
    const room = project.roomId ? await ctx.db.get(project.roomId) : null;
    const brief = briefSchema.parse({
      ...normalizeBrief(room?.brief ?? project.brief ?? emptyBrief()),
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    });
    await ctx.db.patch(projectId, { brief });
    if (room) await ctx.db.patch(room._id, { brief });
    return brief;
  },
});
