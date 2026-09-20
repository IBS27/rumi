import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  hashToken,
  MAX_SCAN_BYTES,
  PACKAGE_CONTENT_PREFIX,
  PAIRING_TTL,
  randomToken,
  UPLOAD_TTL,
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
    await ctx.db.patch(session._id, {
      state: "uploaded",
      storageId: args.storageId,
      digest: args.digest,
      idempotencyKey: args.idempotencyKey,
      format: "json",
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
      format: session.format ?? "json",
      expiresAt: session.expiresAt,
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
    await ctx.db.patch(sessionId, { state: "canceled", storageId: undefined });
    return null;
  },
});

export const removeExpired = internalMutation({
  args: { sessionId: v.id("captures") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (session && session._creationTime + 24 * 60 * 60 * 1000 <= Date.now()) {
      if (session.storageId) await ctx.storage.delete(session.storageId);
      await ctx.db.delete(sessionId);
    }
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

// The random MIME subtype binds an uploaded object to this grant. A caller cannot
// attach or delete someone else's storage object by submitting its storage ID.
export const beginPackage = internalMutation({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    uploadUrl: v.union(v.string(), v.null()),
    contentType: v.string(),
    maxBytes: v.number(),
    uploaded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("captures", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.uploadHash !== args.uploadHash)
      return fail("UNAUTHORIZED");
    if (session.state === "canceled" || session.expiresAt <= Date.now())
      return fail("TOKEN_EXPIRED");
    if (session.packageKey && session.packageKey !== args.idempotencyKey)
      return fail("ALREADY_UPLOADED");
    if (session.state === "uploaded") {
      if (
        session.format !== "zip" ||
        session.idempotencyKey !== args.idempotencyKey
      )
        return fail("ALREADY_UPLOADED");
      return {
        uploadUrl: null,
        contentType: session.packageContentType!,
        maxBytes: MAX_SCAN_BYTES,
        uploaded: true,
      };
    }
    if (session.state !== "paired") return fail("UNAUTHORIZED");
    if (session.uploadAttempts >= 20) return fail("RATE_LIMITED");
    const contentType =
      session.packageContentType ??
      `${PACKAGE_CONTENT_PREFIX}${randomToken()}+zip`;
    await ctx.db.patch(session._id, {
      packageKey: args.idempotencyKey,
      packageContentType: contentType,
      uploadAttempts: session.uploadAttempts + 1,
    });
    return {
      uploadUrl: await ctx.storage.generateUploadUrl(),
      contentType,
      maxBytes: MAX_SCAN_BYTES,
      uploaded: false,
    };
  },
});

export const completePackage = internalMutation({
  args: {
    sessionId: v.string(),
    uploadHash: v.string(),
    idempotencyKey: v.string(),
    storageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("captures", args.sessionId);
    const session = id ? await ctx.db.get(id) : null;
    if (!session || session.uploadHash !== args.uploadHash)
      return fail("UNAUTHORIZED");
    if (session.state === "canceled" || session.expiresAt <= Date.now())
      return fail("TOKEN_EXPIRED");
    if (session.packageKey !== args.idempotencyKey)
      return fail("ALREADY_UPLOADED");
    const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
    const metadata = storageId ? await ctx.db.system.get(storageId) : null;
    if (
      !metadata ||
      !storageId ||
      metadata.contentType !== session.packageContentType
    )
      return fail("INVALID_PACKAGE");
    if (metadata.size <= 0 || metadata.size > MAX_SCAN_BYTES)
      return fail("FILE_TOO_LARGE");
    if (session.state === "uploaded") {
      if (
        session.format !== "zip" ||
        session.digest !== metadata.sha256 ||
        session.idempotencyKey !== args.idempotencyKey
      )
        return fail("ALREADY_UPLOADED");
      if (session.storageId !== storageId) await ctx.storage.delete(storageId);
      return null;
    }
    if (session.state !== "paired") return fail("UNAUTHORIZED");
    await ctx.db.patch(session._id, {
      storageId,
      state: "uploaded",
      format: "zip",
      digest: metadata.sha256,
      idempotencyKey: args.idempotencyKey,
    });
    return null;
  },
});

// Upload URLs can outlive a canceled client, including a lost storage response.
// Sweep only Rumi scan objects, in bounded pages, preserving any attached file.
export const sweepPackages = internalMutation({
  args: { cursor: v.optional(v.string()), before: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const before = args.before ?? Date.now() - 24 * 60 * 60 * 1000;
    const result = await ctx.db.system
      .query("_storage")
      .order("asc")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    for (const file of result.page) {
      if (file._creationTime >= before) return null;
      if (!file.contentType?.startsWith(PACKAGE_CONTENT_PREFIX)) continue;
      const attached = await ctx.db
        .query("captures")
        .withIndex("by_storageId", (q) => q.eq("storageId", file._id))
        .first();
      if (!attached) await ctx.storage.delete(file._id);
    }
    if (!result.isDone)
      await ctx.scheduler.runAfter(0, internal.captures.sweepPackages, {
        cursor: result.continueCursor,
        before,
      });
    return null;
  },
});
