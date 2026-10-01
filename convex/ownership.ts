import type { QueryCtx } from "./_generated/server";

export async function requireActiveOwner(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
) {
  if (
    await ctx.db
      .query("accountDeletions")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique()
  )
    throw new Error("Account deletion has been requested.");
}

// Match capture ownership: issuer + subject, never a browser-supplied device id.
export async function requireOwner(
  ctx: Pick<QueryCtx, "auth"> & { db?: QueryCtx["db"] },
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("UNAUTHENTICATED");
  if (ctx.db) {
    await requireActiveOwner({ db: ctx.db }, identity.tokenIdentifier);
  }
  return identity.tokenIdentifier;
}
