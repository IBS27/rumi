import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
export interface RecordedCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Resume individual calls, preserving the provider's IDs for transactional edit receipts. */
export async function executeRecordedCalls(args: {
  calls: RecordedCall[];
  outputs: Record<string, unknown>;
  tools: ToolSet;
  messages: ModelMessage[];
  save: (callId: string, output: unknown) => Promise<void>;
  started?: (call: RecordedCall) => Promise<void>;
  finished?: (call: RecordedCall) => Promise<void>;
}) {
  for (const call of args.calls) {
    if (!(call.toolCallId in args.outputs)) {
      const definition = args.tools[call.toolName];
      const input =
        definition?.inputSchema instanceof z.ZodType
          ? definition.inputSchema.safeParse(call.input)
          : null;
      let output: unknown;
      if (!definition?.execute || !input?.success) {
        output = {
          ok: false,
          error:
            "Invalid tool arguments. Correct the arguments before retrying this tool.",
        };
      } else {
        await args.started?.(call);
        output = await definition.execute(input.data, {
          toolCallId: call.toolCallId,
          messages: args.messages,
        });
      }
      await args.save(call.toolCallId, output ?? null);
      args.outputs[call.toolCallId] = output ?? null;
      await args.finished?.(call);
    }
    args.messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: {
            type: "text",
            value: JSON.stringify(args.outputs[call.toolCallId]),
          },
        },
      ],
    });
  }
}
