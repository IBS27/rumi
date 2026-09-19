import type { QueryCtx } from "./_generated/server";

// Match capture ownership: issuer + subject, never a browser-supplied device id.
export async function requireOwner(
  ctx: Pick<QueryCtx, "auth">,
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("UNAUTHENTICATED");
  return identity.tokenIdentifier;
}
