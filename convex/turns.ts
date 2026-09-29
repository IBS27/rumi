import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireActiveOwner } from "./ownership";

/** Every write from a model run must still belong to the active, pending reply. */
export async function requireTurn(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  messageId?: Id<"messages">,
) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("This project does not exist.");
  await requireActiveOwner(ctx, project.ownerId);
  if (messageId) {
    const message = await ctx.db.get(messageId);
    if (
      project.activeMessageId !== messageId ||
      message?.projectId !== projectId ||
      message.status !== "pending"
    )
      throw new Error("This design turn is no longer active.");
  }
  return project;
}
