import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  claimBodySchema,
  hashToken,
  MAX_ROOM_BYTES,
} from "../shared/capture/pairing";
import { importRoomPlan } from "../shared/capture/roomplan";

import { upload, uploadOptions } from "./images";

const http = httpRouter();
http.route({ path: "/chat/image", method: "POST", handler: upload });
http.route({ path: "/chat/image", method: "OPTIONS", handler: uploadOptions });
class RequestError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
function token(request: Request): string {
  const value = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!value) throw new RequestError("UNAUTHORIZED", 401);
  return value;
}
async function readBody(request: Request, limit: number): Promise<string> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new RequestError("INVALID_CONTENT_TYPE", 400);
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new RequestError("FILE_TOO_LARGE", 413);
  if (!request.body) throw new RequestError("EMPTY_BODY", 400);
  const reader = request.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0,
    text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new RequestError("FILE_TOO_LARGE", 413);
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError)
      throw new RequestError("INVALID_ENCODING", 400);
    throw error;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
function errorResponse(error: unknown): Response {
  const code =
    error instanceof RequestError
      ? error.code
      : error instanceof ConvexError && typeof error.data === "string"
        ? error.data
        : "INTERNAL_ERROR";
  const statuses: Record<string, number> = {
    UNAUTHORIZED: 401,
    TOKEN_EXPIRED: 410,
    ALREADY_CLAIMED: 409,
    ALREADY_UPLOADED: 409,
    RATE_LIMITED: 429,
  };
  const status =
    error instanceof RequestError ? error.status : (statuses[code] ?? 500);
  return Response.json(
    {
      error: {
        code,
        message:
          status === 410
            ? "Reconnect to Rumi and try again."
            : status === 500
              ? "Upload could not complete. Retry using the same upload key."
              : code.replaceAll("_", " ").toLowerCase(),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "600" } : {}),
      },
    },
  );
}
http.route({
  path: "/capture/v1/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const pairingToken = token(request);
      let body: z.infer<typeof claimBodySchema>;
      try {
        body = claimBodySchema.parse(JSON.parse(await readBody(request, 2048)));
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError("INVALID_REQUEST", 400);
      }
      // Deterministic derivation allows an identical claim retry without storing bearer secrets.
      const uploadToken = await hashToken(
        `rumi-upload-v1:${pairingToken}:${body.claimId}`,
      );
      const expiresAt = await ctx.runMutation(internal.captures.claim, {
        ...body,
        pairingHash: await hashToken(pairingToken),
        uploadHash: await hashToken(uploadToken),
      });
      return Response.json(
        {
          sessionId: body.sessionId,
          uploadToken,
          expiresAt: new Date(expiresAt).toISOString(),
          maxBytes: MAX_ROOM_BYTES,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  }),
});
http.route({
  path: "/capture/v1/room",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const uploadHash = await hashToken(token(request));
      const sessionId = new URL(request.url).searchParams.get("sessionId");
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (
        !sessionId ||
        sessionId.length > 200 ||
        !z.uuid().safeParse(idempotencyKey).success
      )
        throw new RequestError("INVALID_REQUEST", 400);
      await ctx.runMutation(internal.captures.authorizeUpload, {
        sessionId,
        uploadHash,
      });
      const text = await readBody(request, MAX_ROOM_BYTES);
      try {
        importRoomPlan(JSON.parse(text));
      } catch {
        throw new RequestError("INVALID_ROOM", 422);
      }
      const digest = await hashToken(text);
      const storageId = await ctx.storage.store(
        new Blob([text], { type: "application/json" }),
      );
      try {
        await ctx.scheduler.runAfter(
          60 * 60 * 1000,
          internal.captures.removeOrphan,
          { sessionId, storageId },
        );
        await ctx.runMutation(internal.captures.complete, {
          sessionId,
          uploadHash,
          storageId,
          digest,
          idempotencyKey: idempotencyKey!,
        });
      } catch (error) {
        await ctx.storage.delete(storageId);
        throw error;
      }
      return Response.json(
        { sessionId, status: "uploaded" },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return errorResponse(error);
    }
  }),
});
export default http;
