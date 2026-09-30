import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireActiveOwner } from "./ownership";

/**
 * Operator recovery increments a reply's runAttempt. Writes carry the attempt
 * they were started with; replies from before recovery existed are attempt 0.
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
