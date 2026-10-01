import type { convexTest } from "convex-test";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Test = ReturnType<typeof convexTest>;

/** Start a pending assistant reply, as messages.send does, so agent writes can name it. */
export function startTurn(t: Test, projectId: Id<"projects">) {
  return t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", {
      projectId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: Date.now(),
    });
    await ctx.db.patch(projectId, { activeMessageId: messageId });
    return messageId;
  });
}

/** Run agent writes inside one reply, then finish it so the user can act again. */
export async function inTurn<T>(
  t: Test,
  projectId: Id<"projects">,
  write: (messageId: Id<"messages">) => Promise<T>,
) {
  const messageId = await startTurn(t, projectId);
  const result = await write(messageId);
  await t.mutation(internal.messages.complete, {
    messageId,
    content: "",
    status: "done",
  });
  return result;
}
