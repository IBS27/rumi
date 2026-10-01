import { Webhook } from "svix";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { boundedBody } from "../shared/network/policy";
export const receive = httpAction(async (ctx, request) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  const issuer = process.env.CLERK_JWT_ISSUER_DOMAIN;
  if (!secret || !issuer) return new Response(null, { status: 503 });
  let event: unknown;
  try {
    const body = new TextDecoder().decode(
      await boundedBody(
        new Response(request.body, { headers: request.headers }),
        1024 * 1024,
      ),
    );
    new Webhook(secret).verify(body, Object.fromEntries(request.headers));
    event = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const deleted = z
    .object({
      type: z.literal("user.deleted"),
      data: z.object({ id: z.string() }),
    })
    .safeParse(event);
  if (deleted.success)
    await ctx.runMutation(internal.accounts.beginDeletion, {
      ownerId: `${issuer.replace(/\/$/, "")}|${deleted.data.data.id}`,
    });
  return new Response(null, { status: 204 });
});
