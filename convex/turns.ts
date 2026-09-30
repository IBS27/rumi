import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireActiveOwner } from "./ownership";

/**
 * A reply write is admitted only when it names its reply and that reply's
 * current attempt. A missing attempt means attempt 0 of the named reply, which
 * is only its original run: a retry creates a new reply, and operator recovery
 * increments runAttempt. A write that does not name its reply cannot prove
 * which run it came from and must be rejected.
 */
export const currentAttempt = (message: Doc<"messages">, attempt?: number) =>
  (message.runAttempt ?? 0) === (attempt ?? 0);

/** Every write from a model run must still belong to the active, pending reply and attempt. */
export async function requireTurn(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  messageId?: Id<"messages">,
  attempt?: number,
) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("This project does not exist.");
  await requireActiveOwner(ctx, project.ownerId);
  if (messageId) {
    const message = await ctx.db.get(messageId);
    if (
      project.activeMessageId !== messageId ||
      message?.projectId !== projectId ||
      message.status !== "pending" ||
      !currentAttempt(message, attempt)
    )
      throw new Error("This design turn is no longer active.");
  }
  return project;
}
