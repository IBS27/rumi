import { describe, expect, it } from "bun:test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { executeRecordedCalls } from "../shared/agent/execute";

describe("checkpointed tool execution", () => {
  it("resumes after an interrupted call and retains the original idempotency key", async () => {
    const committed = new Map<string, number>();
    const outputs: Record<string, unknown> = {};
    const calls = [
      { toolCallId: "edit-a", toolName: "edit", input: { amount: 1 } },
      { toolCallId: "edit-b", toolName: "edit", input: { amount: 2 } },
    ];
    const tools = {
      edit: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }, { toolCallId }) => {
          if (!committed.has(toolCallId)) committed.set(toolCallId, amount);
          return { amount: committed.get(toolCallId) };
        },
      }),
    };
    let failed = false;
    const save = async (id: string, result: unknown) => {
      if (id === "edit-b" && !failed) {
        failed = true;
        throw new Error("Lost response after edit committed");
      }
      outputs[id] = result;
    };
    await expect(
      executeRecordedCalls({ calls, tools, outputs, messages: [], save }),
    ).rejects.toThrow("Lost response");
    expect(Object.keys(outputs)).toEqual(["edit-a"]);
    const messages: ModelMessage[] = [];
    await executeRecordedCalls({ calls, tools, outputs, messages, save });
    expect([...committed]).toEqual([
      ["edit-a", 1],
      ["edit-b", 2],
    ]);
    expect(messages).toHaveLength(2);
    expect(outputs["edit-b"]).toEqual({ amount: 2 });
  });
  it("returns invalid arguments to the model for repair without executing a tool", async () => {
    let edits = 0;
    const outputs: Record<string, unknown> = {};
    await executeRecordedCalls({
      calls: [{ toolCallId: "bad", toolName: "edit", input: { amount: "no" } }],
      outputs,
      messages: [],
      tools: {
        edit: tool({
          inputSchema: z.object({ amount: z.number() }),
          execute: async () => {
            edits++;
            return true;
          },
        }),
      },
      save: async () => undefined,
    });
    expect(edits).toBe(0);
    expect(outputs.bad).toEqual({
      ok: false,
      error: expect.stringContaining("Invalid tool arguments"),
    });
  });
});
