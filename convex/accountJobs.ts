"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
export const deleteIdentity = internalAction({
  args: { ownerId: v.string(), subject: v.string(), attempt: v.number() },
  handler: async (ctx, { ownerId, subject, attempt }) => {
    try {
      const key = process.env.CLERK_SECRET_KEY;
      if (!key) throw new Error("CLERK_SECRET_KEY is missing.");
      const response = await fetch(
        `https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok && response.status !== 404)
        throw new Error(`Identity deletion returned ${response.status}.`);
      await ctx.runMutation(internal.accounts.identityResult, { ownerId });
    } catch (error) {
      await ctx.runMutation(internal.accounts.identityResult, {
        ownerId,
        error:
          error instanceof Error ? error.message : "Identity deletion failed.",
      });
      if (attempt < 5)
        await ctx.scheduler.runAfter(
          10000 * 2 ** attempt,
          internal.accountJobs.deleteIdentity,
          { ownerId, subject, attempt: attempt + 1 },
        );
    }
  },
});
