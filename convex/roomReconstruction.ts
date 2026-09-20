import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireOwner } from "./ownership";
import { openai } from "@ai-sdk/openai";
import { hashToken } from "../shared/capture/pairing";
import {
  MAX_EVIDENCE_BYTES,
  MAX_RECONSTRUCTION_MS,
  RECONSTRUCTION_MODEL,
  RECONSTRUCTION_APPEARANCE,
  reconstructionInputSchema,
  reconstructedObjectSchema,
} from "../shared/reconstruction/contracts";
import {
  analyzeRoomReconstruction,
  modelRoomReconstruction,
  assembleRoomReconstruction,
  reconstructionInventory,
  planSchema,
  reconstructionFailure,
} from "./roomReconstructionGeneration";

const stage = v.union(
  v.literal("queued"),
  v.literal("analyzing"),
  v.literal("modeling"),
  v.literal("ready"),
  v.literal("failed"),
);
const publicResult = v.object({
  stage,
  completed: v.number(),
  total: v.number(),
  error: v.union(v.string(), v.null()),
  sceneJson: v.union(v.string(), v.null()),
  attempt: v.number(),
});

async function requireCapacity(ctx: MutationCtx, ownerId: string) {
  const active = await Promise.all(
    (["queued", "analyzing", "modeling"] as const).map((stage) =>
      ctx.db
        .query("roomReconstructions")
        .withIndex("by_ownerId_stage", (q) =>
          q.eq("ownerId", ownerId).eq("stage", stage),
        )
        .take(2),
    ),
  );
  if (active.flat().length >= 2)
    throw new Error(
      "Two rooms are already processing. Wait for one to finish.",
    );
}

export const get = query({
  args: { id: v.id("roomReconstructions") },
  returns: v.union(v.null(), publicResult),
  handler: async (ctx, { id }) => {
    const ownerId = await requireOwner(ctx);
    const job = await ctx.db.get(id);
    if (!job || job.ownerId !== ownerId) return null;
    return {
      stage: job.stage,
      completed: job.completed,
      total: job.total,
      error: job.error ?? null,
      sceneJson: job.sceneJson ?? null,
      attempt: job.attempt,
    };
  },
});
export const find = internalQuery({
  args: { ownerId: v.string(), digest: v.string() },
  returns: v.union(v.id("roomReconstructions"), v.null()),
  handler: async (ctx, args) =>
    (
      await ctx.db
        .query("roomReconstructions")
        .withIndex("by_ownerId_digest", (q) =>
          q.eq("ownerId", args.ownerId).eq("digest", args.digest),
        )
        .unique()
    )?._id ?? null,
});

export const start = action({
  args: { inputJson: v.string() },
  returns: v.id("roomReconstructions"),
  handler: async (ctx, { inputJson }): Promise<Id<"roomReconstructions">> => {
    const ownerId = await requireOwner(ctx);
    if (new TextEncoder().encode(inputJson).byteLength > MAX_EVIDENCE_BYTES)
      throw new Error("Scan evidence exceeds 5 MB.");
    const input = reconstructionInputSchema.parse(JSON.parse(inputJson));
    if (input.room.shape !== "polygon" || input.room.capture.synthetic)
      throw new Error("Use a real captured room for reconstruction.");
    const canonical = JSON.stringify(input);
    const digest = await hashToken(`${RECONSTRUCTION_APPEARANCE}:${canonical}`);
    const existing = await ctx.runQuery(internal.roomReconstruction.find, {
      ownerId,
      digest,
    });
    if (existing) return existing;
    const inputId = await ctx.storage.store(
      new Blob([canonical], { type: "application/json" }),
    );
    try {
      const result = await ctx.runMutation(
        internal.roomReconstruction.enqueue,
        { ownerId, digest, inputId, total: input.room.objects.length },
      );
      if (!result.created) await ctx.storage.delete(inputId);
      return result.id;
    } catch (error) {
      await ctx.storage.delete(inputId);
      throw error;
    }
  },
});
export const enqueue = internalMutation({
  args: {
    ownerId: v.string(),
    digest: v.string(),
    inputId: v.id("_storage"),
    total: v.number(),
  },
  returns: v.object({ id: v.id("roomReconstructions"), created: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("roomReconstructions")
      .withIndex("by_ownerId_digest", (q) =>
        q.eq("ownerId", args.ownerId).eq("digest", args.digest),
      )
      .unique();
    if (existing) return { id: existing._id, created: false };
    const recent = await ctx.db
      .query("roomReconstructions")
      .withIndex("by_ownerId", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .gte("_creationTime", Date.now() - 86_400_000),
      )
      .take(25);
    if (recent.length >= 24)
      throw new Error(
        "Daily room reconstruction limit reached. Try again tomorrow.",
      );
    await requireCapacity(ctx, args.ownerId);
    const id = await ctx.db.insert("roomReconstructions", {
      ...args,
      stage: "queued",
      completed: 0,
      attempt: 1,
    });
    await ctx.scheduler.runAfter(0, internal.roomReconstruction.run, {
      id,
      attempt: 1,
    });
    await ctx.scheduler.runAfter(
      MAX_RECONSTRUCTION_MS + 30_000,
      internal.roomReconstruction.expire,
      { id, attempt: 1 },
    );
    return { id, created: true };
  },
});
export const retry = mutation({
  args: { id: v.id("roomReconstructions") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const ownerId = await requireOwner(ctx);
    const job = await ctx.db.get(id);
    if (!job || job.ownerId !== ownerId)
      throw new Error("Room reconstruction not found.");
    if (job.stage !== "failed") return null;
    if (job.attempt >= 3)
      throw new Error(
        "This reconstruction failed three times. Your original scan is still available.",
      );
    await requireCapacity(ctx, ownerId);
    const attempt = job.attempt + 1;
    await ctx.db.patch(id, {
      stage: "queued",
      error: undefined,
      completed: (job.batches ?? []).reduce(
        (sum, batch) => sum + batch.objectIds.length,
        0,
      ),
      step: 0,
      attempt,
    });
    await ctx.scheduler.runAfter(0, internal.roomReconstruction.run, {
      id,
      attempt,
    });
    await ctx.scheduler.runAfter(
      MAX_RECONSTRUCTION_MS + 30_000,
      internal.roomReconstruction.expire,
      { id, attempt },
    );
    return null;
  },
});
export const source = internalQuery({
  args: { id: v.id("roomReconstructions"), attempt: v.number() },
  returns: v.union(v.id("_storage"), v.null()),
  handler: async (ctx, { id, attempt }) => {
    const job = await ctx.db.get(id);
    return job?.attempt === attempt && job.stage === "queued"
      ? job.inputId
      : null;
  },
});
export const update = internalMutation({
  args: {
    id: v.id("roomReconstructions"),
    attempt: v.number(),
    step: v.optional(v.number()),
    stage,
    completed: v.optional(v.number()),
    total: v.optional(v.number()),
    sceneJson: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, attempt, step, ...patch }) => {
    const job = await ctx.db.get(id);
    if (
      job?.attempt === attempt &&
      (step === undefined || (job.step ?? 0) === step) &&
      job.stage !== "ready" &&
      job.stage !== "failed"
    )
      await ctx.db.patch(id, patch);
    return null;
  },
});
export const expire = internalMutation({
  args: {
    id: v.id("roomReconstructions"),
    attempt: v.number(),
    step: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { id, attempt, step }) => {
    const job = await ctx.db.get(id);
    if (
      job?.attempt === attempt &&
      (job.step ?? 0) === (step ?? 0) &&
      job.stage !== "ready" &&
      job.stage !== "failed"
    )
      await ctx.db.patch(id, {
        stage: "failed",
        error:
          "Reconstruction timed out. Your scan and completed models are saved. Try again to resume.",
      });
    return null;
  },
});
const stepArgs = {
  id: v.id("roomReconstructions"),
  attempt: v.number(),
  step: v.optional(v.number()),
};

// Claim each scheduled stage once. Attempt and step fence late writes and watchdogs.
export const claim = internalMutation({
  args: stepArgs,
  returns: v.union(
    v.null(),
    v.object({
      inputId: v.id("_storage"),
      planId: v.union(v.id("_storage"), v.null()),
      batchIds: v.array(v.id("_storage")),
    }),
  ),
  handler: async (ctx, { id, attempt, step = 0 }) => {
    const job = await ctx.db.get(id);
    if (
      !job ||
      job.attempt !== attempt ||
      (job.step ?? 0) !== step ||
      job.stage !== "queued"
    )
      return null;
    await ctx.db.patch(id, { stage: job.planId ? "modeling" : "analyzing" });
    return {
      inputId: job.inputId,
      planId: job.planId ?? null,
      batchIds: (job.batches ?? []).map((batch) => batch.storageId),
    };
  },
});

export const checkpoint = internalMutation({
  args: {
    ...stepArgs,
    storageId: v.id("_storage"),
    objectIds: v.optional(v.array(v.string())),
    total: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { id, attempt, step = 0, storageId, objectIds, total },
  ) => {
    const job = await ctx.db.get(id);
    if (
      !job ||
      job.attempt !== attempt ||
      (job.step ?? 0) !== step ||
      !["analyzing", "modeling"].includes(job.stage)
    ) {
      await ctx.storage.delete(storageId);
      return null;
    }
    if (objectIds) {
      const batches = job.batches ?? [];
      if (
        batches.some((batch) =>
          batch.objectIds.some((objectId) => objectIds.includes(objectId)),
        )
      ) {
        await ctx.storage.delete(storageId);
        return null;
      }
      batches.push({ storageId, objectIds });
      await ctx.db.patch(id, {
        batches,
        completed: batches.reduce(
          (sum, batch) => sum + batch.objectIds.length,
          0,
        ),
      });
    } else {
      await ctx.db.patch(id, { planId: storageId, total });
    }
    return null;
  },
});

export const continueJob = internalMutation({
  args: stepArgs,
  returns: v.null(),
  handler: async (ctx, { id, attempt, step = 0 }) => {
    const job = await ctx.db.get(id);
    if (
      !job ||
      job.attempt !== attempt ||
      (job.step ?? 0) !== step ||
      !["analyzing", "modeling"].includes(job.stage)
    )
      return null;
    const next = { id, attempt, step: step + 1 };
    await ctx.db.patch(id, { stage: "queued", step: next.step });
    await ctx.scheduler.runAfter(0, internal.roomReconstruction.run, next);
    await ctx.scheduler.runAfter(
      MAX_RECONSTRUCTION_MS + 30_000,
      internal.roomReconstruction.expire,
      next,
    );
    return null;
  },
});

export const run = internalAction({
  args: stepArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.runMutation(
      internal.roomReconstruction.claim,
      args,
    );
    if (!source) return null;
    const started = Date.now();
    const stageName = source.planId ? "modeling" : "analyzing";
    console.info("Reconstruction stage started", {
      id: args.id,
      attempt: args.attempt,
      step: args.step ?? 0,
      stage: stageName,
    });
    try {
      const blob = await ctx.storage.get(source.inputId);
      if (!blob || blob.size > MAX_EVIDENCE_BYTES)
        throw new Error("Missing scan evidence.");
      const input = reconstructionInputSchema.parse(
        JSON.parse(await blob.text()),
      );
      const signal = AbortSignal.timeout(MAX_RECONSTRUCTION_MS);
      const model = openai(RECONSTRUCTION_MODEL);
      if (!source.planId) {
        const plan = await analyzeRoomReconstruction(model, input, signal);
        const storageId = await ctx.storage.store(
          new Blob([JSON.stringify(plan)], { type: "application/json" }),
        );
        await ctx.runMutation(internal.roomReconstruction.checkpoint, {
          ...args,
          storageId,
          total: reconstructionInventory(input, plan).length,
        });
        await ctx.runMutation(internal.roomReconstruction.continueJob, args);
      } else {
        const planBlob = await ctx.storage.get(source.planId);
        if (!planBlob) throw new Error("Missing reconstruction plan.");
        const plan = planSchema.parse(JSON.parse(await planBlob.text()));
        const saved = (
          await Promise.all(
            source.batchIds.map(async (id) => {
              const batch = await ctx.storage.get(id);
              if (!batch) throw new Error("Missing completed models.");
              return reconstructedObjectSchema
                .array()
                .parse(JSON.parse(await batch.text()));
            }),
          )
        ).flat();
        // Only one concurrent wave per action; every wave gets its own deadline.
        const objects = await modelRoomReconstruction(
          model,
          input,
          plan,
          async () => {},
          signal,
          saved,
          3,
          async (batch) => {
            const storageId = await ctx.storage.store(
              new Blob([JSON.stringify(batch)], { type: "application/json" }),
            );
            await ctx.runMutation(internal.roomReconstruction.checkpoint, {
              ...args,
              storageId,
              objectIds: batch.map((object) => object.objectId),
            });
            console.info("Reconstruction batch saved", {
              id: args.id,
              count: batch.length,
              elapsedMs: Date.now() - started,
            });
          },
        );
        if (objects.length === reconstructionInventory(input, plan).length) {
          const scene = assembleRoomReconstruction(input, plan, objects);
          await ctx.runMutation(internal.roomReconstruction.update, {
            ...args,
            stage: "ready",
            sceneJson: JSON.stringify(scene),
            completed: objects.length,
          });
        } else {
          await ctx.runMutation(internal.roomReconstruction.continueJob, args);
        }
      }
      console.info("Reconstruction stage completed", {
        id: args.id,
        step: args.step ?? 0,
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      console.error("Room reconstruction failed", args.id, {
        stage: stageName,
        step: args.step ?? 0,
        elapsedMs: Date.now() - started,
        ...reconstructionFailure(error),
      });
      await ctx.runMutation(internal.roomReconstruction.update, {
        ...args,
        stage: "failed",
        error:
          "Reconstruction paused. Your scan and completed models are saved. Try again to resume.",
      });
    }
    return null;
  },
});
