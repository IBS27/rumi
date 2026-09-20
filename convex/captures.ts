import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  hashToken,
  PAIRING_TTL,
  randomToken,
  UPLOAD_TTL,
  scanUploadSchema,
  scanContentType,
} from "../shared/capture/pairing";

const fail = (code: string): never => {
  throw new ConvexError(code);
};

export const reserve = internalMutation({
  args: { ownerId: v.string(), pairingHash: v.string() },
  returns: v.object({ sessionId: v.id("captures"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("captures")
      .withIndex("by_ownerId", (q) =>
        q.eq("ownerId", args.ownerId).gte("_creationTime", now - PAIRING_TTL),
      )
      .take(5);
    if (recent.length >= 5) fail("RATE_LIMITED");
    const expiresAt = now + PAIRING_TTL;
    const sessionId = await ctx.db.insert("captures", {
      ...args,
      state: "waiting",
      pairingExpiresAt: expiresAt,
      expiresAt,
      uploadAttempts: 0,
    });
    await ctx.scheduler.runAfter(
      24 * 60 * 60 * 1000,
      internal.captures.removeExpired,
      { sessionId },
    );
    return { sessionId, expiresAt };
  },
});

export const create = action({
  args: {},
  returns: v.object({
    type: v.literal("rumi.capture"),
    version: v.literal(1),
    baseUrl: v.string(),
    sessionId: v.id("captures"),
    pairingToken: v.string(),
    expiresAt: v.string(),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return fail("UNAUTHENTICATED");
    const baseUrl = process.env.CONVEX_SITE_URL;
    if (!baseUrl?.startsWith("https://")) return fail("NOT_CONFIGURED");
    const pairingToken = randomToken();
    const result: { sessionId: Id<"captures">; expiresAt: number } =
      await ctx.runMutation(internal.captures.reserve, {
        ownerId: identity.tokenIdentifier,
        pairingHash: await hashToken(pairingToken),
      });
    return {
      type: "rumi.capture" as const,
      version: 1 as const,
      baseUrl,
      sessionId: result.sessionId,
      pairingToken,
      expiresAt: new Date(result.expiresAt).toISOString(),
    };
  },
});

export const claim = internalMutation({
  args: {
    sessionId: v.string(),
    pairingHash: v.string(),
    claimId: v.string(),
    uploadHash: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("captures", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.pairingHash !== args.pairingHash)
      return fail("UNAUTHORIZED");
    if (session.state === "canceled" || session.pairingExpiresAt <= Date.now())
      return fail("TOKEN_EXPIRED");
    if (session.claimId) {
      if (session.claimId !== args.claimId) return fail("ALREADY_CLAIMED");
      return session.expiresAt;
    }
    const expiresAt = Date.now() + UPLOAD_TTL;
    await ctx.db.patch(session._id, {
      state: "paired",
      claimId: args.claimId,
      uploadHash: args.uploadHash,
      expiresAt,
    });
    return expiresAt;
  },
});

export const authorizeUpload = internalMutation({
  args: { sessionId: v.string(), uploadHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("captures", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (
      !session ||
      !session.uploadHash ||
      session.uploadHash !== args.uploadHash
    )
      return fail("UNAUTHORIZED");
    if (session.state === "canceled" || session.expiresAt <= Date.now())
      return fail("TOKEN_EXPIRED");
    if (session.uploadAttempts >= 20) return fail("RATE_LIMITED");
    await ctx.db.patch(session._id, {
      uploadAttempts: session.uploadAttempts + 1,
    });
    return null;
  },
});

export const complete = internalMutation({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    storageId: v.id("_storage"),
    digest: v.string(),
    idempotencyKey: v.string(),
    format: v.optional(v.union(v.literal("json"), v.literal("zip"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("captures", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.uploadHash !== args.uploadHash)
      return fail("UNAUTHORIZED");
    if (session.state === "canceled" || session.expiresAt <= Date.now())
      return fail("TOKEN_EXPIRED");
    if (session.state === "uploaded") {
      if (
        session.digest !== args.digest ||
        session.idempotencyKey !== args.idempotencyKey
      )
        return fail("ALREADY_UPLOADED");
      if (session.storageId !== args.storageId)
        await ctx.storage.delete(args.storageId);
      return null;
    }
    if (session.state !== "paired") return fail("UNAUTHORIZED");
    if (
      session.scanUpload &&
      (args.format !== "zip" ||
        session.scanStorageId !== args.storageId ||
        session.scanUpload.digest !== args.digest ||
        session.scanUpload.idempotencyKey !== args.idempotencyKey)
    )
      return fail("ALREADY_UPLOADED");
    await ctx.db.patch(session._id, {
      state: "uploaded",
      storageId: args.storageId,
      digest: args.digest,
      idempotencyKey: args.idempotencyKey,
      format: args.format ?? "json",
    });
    return null;
  },
});

export const get = query({
  args: { sessionId: v.id("captures") },
  returns: v.union(
    v.null(),
    v.object({
      state: v.union(
        v.literal("waiting"),
        v.literal("paired"),
        v.literal("uploaded"),
        v.literal("canceled"),
      ),
      expiresAt: v.number(),
      fileUrl: v.union(v.string(), v.null()),
      format: v.union(v.literal("json"), v.literal("zip")),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const session = await ctx.db.get(sessionId);
    if (!session || session.ownerId !== identity.tokenIdentifier) return null;
    return {
      state: session.state,
      expiresAt: session.expiresAt,
      format: session.format ?? "json",
      fileUrl:
        session.state === "uploaded" && session.storageId
          ? await ctx.storage.getUrl(session.storageId)
          : null,
    };
  },
});

export const cancel = mutation({
  args: { sessionId: v.id("captures") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    const session = await ctx.db.get(sessionId);
    if (!identity || !session || session.ownerId !== identity.tokenIdentifier)
      return fail("UNAUTHORIZED");
    // Closing the QR dialog can race the upload subscription. An accepted room
    // belongs to the workspace and must remain available for delivery.
    if (session.state === "uploaded") return null;
    if (session.scanStorageId) await ctx.storage.delete(session.scanStorageId);
    await ctx.db.patch(sessionId, {
      state: "canceled",
      storageId: undefined,
      scanStorageId: undefined,
    });
    return null;
  },
});

export const removeExpired = internalMutation({
  args: { sessionId: v.id("captures"), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { sessionId, cursor }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session._creationTime + 24 * 60 * 60 * 1000 > Date.now())
      return null;
    if (session.scanUpload) {
      // Direct-upload responses can be lost before the phone registers an ID.
      // Scan only this session's possible upload window, in bounded pages, and
      // delete only files explicitly tagged for it. Never sweep other app files.
      const page = await ctx.db.system
        .query("_storage")
        .withIndex("by_creation_time", (q) =>
          q
            .gte("_creationTime", session.scanUpload!.startedAt)
            .lte("_creationTime", session.expiresAt + UPLOAD_TTL + 120_000),
        )
        .paginate({ cursor: cursor ?? null, numItems: 100 });
      for (const file of page.page) {
        if (file.contentType === scanContentType(sessionId))
          await ctx.storage.delete(file._id);
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.captures.removeExpired, {
          sessionId,
          cursor: page.continueCursor,
        });
        return null;
      }
    }
    for (const id of new Set([session.storageId, session.scanStorageId])) {
      if (id && (await ctx.db.system.get(id))) await ctx.storage.delete(id);
    }
    await ctx.db.delete(sessionId);
    return null;
  },
});

export const removeOrphan = internalMutation({
  args: { sessionId: v.string(), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { sessionId, storageId }) => {
    const id = ctx.db.normalizeId("captures", sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.storageId !== storageId)
      await ctx.storage.delete(storageId);
    return null;
  },
});

async function scanSession(
  ctx: MutationCtx,
  sessionId: string,
  uploadHash: string,
) {
  const id = ctx.db.normalizeId("captures", sessionId);
  const session = id ? await ctx.db.get(id) : null;
  if (!session || !session.uploadHash || session.uploadHash !== uploadHash)
    return fail("UNAUTHORIZED");
  if (session.state === "canceled" || session.expiresAt <= Date.now())
    return fail("TOKEN_EXPIRED");
  if (session.state !== "paired" && session.state !== "uploaded")
    return fail("UNAUTHORIZED");
  return session;
}

// Reserve immutable content before issuing a storage capability. Retrying resumes
// an attached file or confirms an accepted scan without uploading it again.
export const startScanUpload = internalMutation({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    idempotencyKey: v.string(),
    digest: v.string(),
    size: v.number(),
  },
  returns: v.object({
    uploaded: v.boolean(),
    uploadUrl: v.union(v.string(), v.null()),
    contentType: v.string(),
    storageId: v.union(v.id("_storage"), v.null()),
  }),
  handler: async (ctx, args) => {
    if (!scanUploadSchema.safeParse(args).success)
      return fail("INVALID_REQUEST");
    const session = await scanSession(ctx, args.sessionId, args.uploadHash);
    const pending = session.scanUpload;
    if (
      pending &&
      (pending.digest !== args.digest ||
        pending.size !== args.size ||
        pending.idempotencyKey !== args.idempotencyKey)
    )
      return fail("ALREADY_UPLOADED");
    if (session.state === "uploaded") {
      if (
        session.format !== "zip" ||
        session.digest !== args.digest ||
        session.idempotencyKey !== args.idempotencyKey
      )
        return fail("ALREADY_UPLOADED");
      return {
        uploaded: true,
        uploadUrl: null,
        storageId: null,
        contentType: scanContentType(session._id),
      };
    }
    if (session.uploadAttempts >= 20) return fail("RATE_LIMITED");
    await ctx.db.patch(session._id, {
      uploadAttempts: session.uploadAttempts + 1,
      scanUpload: pending ?? {
        idempotencyKey: args.idempotencyKey,
        digest: args.digest,
        size: args.size,
        startedAt: Date.now(),
      },
    });
    return {
      uploaded: false,
      contentType: scanContentType(session._id),
      storageId: session.scanStorageId ?? null,
      uploadUrl: session.scanStorageId
        ? null
        : await ctx.storage.generateUploadUrl(),
    };
  },
});

export const attachScanUpload = internalMutation({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    idempotencyKey: v.string(),
    storageId: v.string(),
  },
  returns: v.object({
    uploaded: v.boolean(),
    storageId: v.id("_storage"),
    digest: v.string(),
  }),
  handler: async (ctx, args) => {
    const session = await scanSession(ctx, args.sessionId, args.uploadHash);
    const pending = session.scanUpload;
    if (!pending || pending.idempotencyKey !== args.idempotencyKey)
      return fail("UNAUTHORIZED");
    const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
    if (!storageId) return fail("INVALID_SCAN");
    if (session.scanStorageId && session.scanStorageId !== storageId)
      return fail("ALREADY_UPLOADED");
    if (session.state === "uploaded") {
      if (session.storageId !== storageId || session.format !== "zip")
        return fail("ALREADY_UPLOADED");
      return { uploaded: true, storageId, digest: pending.digest };
    }
    // Never read or delete a caller-supplied storage ID until it matches the
    // previously reserved bytes and was created after this upload was authorized.
    const metadata = await ctx.db.system.get(storageId);
    if (
      !metadata ||
      metadata.size !== pending.size ||
      metadata.sha256 !== pending.digest ||
      metadata.contentType !== scanContentType(session._id) ||
      metadata._creationTime < pending.startedAt
    )
      return fail("INVALID_SCAN");
    const existing = await ctx.db
      .query("captures")
      .withIndex("by_scanStorageId", (q) => q.eq("scanStorageId", storageId))
      .first();
    if (existing && existing._id !== session._id) return fail("UNAUTHORIZED");
    if ((session.scanValidationAttempts ?? 0) >= 20)
      return fail("RATE_LIMITED");
    await ctx.db.patch(session._id, {
      scanStorageId: storageId,
      scanValidationAttempts: (session.scanValidationAttempts ?? 0) + 1,
    });
    return { uploaded: false, storageId, digest: pending.digest };
  },
});
