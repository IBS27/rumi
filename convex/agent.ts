import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  roomObjectSchema,
  searchTaskSchema,
  type DesignBrief,
  type DesignProposal,
  type RoomSnapshot,
  type SearchTaskResult,
} from "../shared/contracts";
import { selectionTotal } from "../shared/budget";
import { findPlacement, placementIssue } from "../shared/geometry";

const SYSTEM_PROMPT = `You are the room designer for rumi. You build rooms from real web products.
- Start with getRoomContext. Respect owned and locked objects.
- Work in meters and USD cents. Never infer dimensions that were not given.
- Inspiration-image messages include a visual analysis from a specialist model. Use its style, palette, material, lighting, and furniture cues, but never treat it as verified room geometry or exact dimensions.
- Save style, budget, and restrictions with updateBrief as soon as the user states them.
- Decide what information is most useful to ask for next. You may ask about any design detail, room constraint, preference, priority, tradeoff, or missing measurement.
- When a useful question has 2-4 reasonable choices, call askOptions instead of writing the question as plain text. Create choices that fit the current room and conversation; do not use a fixed questionnaire. The user can also type a custom answer in the card.
- Ask only one focused question per turn. After calling askOptions, do not call another tool and do not write a text reply. Wait for the user's option click or custom answer.
- Use a normal text question only when useful answers cannot be represented by 2-4 choices.
- Only propose products that searchProducts returned. Never invent ids, prices, or dimensions.
- If searchProducts reports that web search is not configured, say so and keep refining the brief instead of proposing products.
- Check the budget with checkBudget before proposeDesign.
- Validate each addition with validatePlacement before calling proposeDesign.
- proposeDesign applies additions atomically. A rejection returns an error you can fix and retry.`;

interface State<T> {
  get: () => T;
  set: (value: T) => void;
}

function buildAgentTools(
  ctx: ActionCtx,
  state: State<RoomSnapshot>,
  roomId: Id<"rooms">,
  brief: State<DesignBrief>,
  projectId: Id<"projects"> | null,
): ToolSet {
  return {
    ...(projectId
      ? {
          askOptions: tool({
            description:
              "Present the user 2-4 concrete options to pick from, for example a style direction, budget range, or palette. The conversation pauses until they answer; end your turn after calling this.",
            inputSchema: z.object({
              question: z.string(),
              options: z.array(z.string()).min(2).max(4),
              multiSelect: z.boolean().default(false),
            }),
            execute: async ({ question, options, multiSelect }) => {
              await ctx.runMutation(internal.messages.ask, {
                projectId,
                question,
                options,
                multiSelect,
              });
              return {
                presented: true,
                note: "Options shown to the user. End your turn and wait for their selection.",
              };
            },
          }),
        }
      : {}),
    getRoomContext: tool({
      description:
        "Return the room snapshot (dimensions, openings, placed objects) and the design brief.",
      inputSchema: z.object({}),
      execute: async () => ({ room: state.get(), brief: brief.get() }),
    }),
    updateBrief: tool({
      description:
        "Save design preferences the user has stated: prompt, style terms, budget in cents, and restrictions.",
      inputSchema: z.object({
        prompt: z.string().optional(),
        styles: z.array(z.string()).optional(),
        budgetCents: z.number().int().nonnegative().optional(),
        restrictions: z.array(z.string()).optional(),
      }),
      execute: async (patch) => {
        const next = await ctx.runMutation(internal.rooms.patchBrief, {
          roomId,
          ...patch,
        });
        brief.set(next);
        return next;
      },
    }),
    searchProducts: tool({
      description:
        "Search the web for one furniture category. Returns validated products with prices, dimensions, and source URLs, plus failures for dropped candidates. Derive maxPriceCents and maxFootprint from the room and budget, not guesses.",
      inputSchema: searchTaskSchema,
      execute: async (task): Promise<SearchTaskResult> => {
        try {
          return await ctx.runAction(internal.search.searchProducts, { task });
        } catch (error) {
          return {
            products: [],
            explanation:
              "Web search is not configured in this deployment yet.",
            failures: [
              {
                stage: "search",
                detail:
                  error instanceof Error ? error.message : "search failed",
              },
            ],
          };
        }
      },
    }),
    getProductDetails: tool({
      description: "Fetch stored details for products by catalog id.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
      execute: async ({ ids }) =>
        await ctx.runQuery(internal.products.getByIds, { ids }),
    }),
    checkBudget: tool({
      description:
        "Return the budget, the priced total of the current selection, and the remaining amount in cents.",
      inputSchema: z.object({}),
      execute: async () => {
        const ids = state
          .get()
          .objects.map((object) => object.productId)
          .filter((id): id is string => id !== null);
        const products = await ctx.runQuery(internal.products.getByIds, {
          ids,
        });
        try {
          const totalCents = selectionTotal(state.get(), products);
          return {
            budgetCents: brief.get().budgetCents,
            totalCents,
            remainingCents: brief.get().budgetCents - totalCents,
          };
        } catch {
          return {
            budgetCents: brief.get().budgetCents,
            unpricedProductIds: ids.filter(
              (id) => !products.some((product) => product.id === id),
            ),
          };
        }
      },
    }),
    validatePlacement: tool({
      description:
        "Check whether a proposed room object fits the room, avoids collisions, and keeps doorway clearance. Returns an issue string or null, plus a suggested placement when available.",
      inputSchema: z.object({ object: roomObjectSchema }),
      execute: async ({ object }) => {
        const issue = placementIssue(state.get(), object);
        if (!issue) return { issue: null };
        if (!object.productId) return { issue };
        const products = await ctx.runQuery(internal.products.getByIds, {
          ids: [object.productId],
        });
        const suggested = products[0]
          ? findPlacement(state.get(), products[0])
          : null;
        return { issue, suggested };
      },
    }),
    proposeDesign: tool({
      description:
        "Apply product additions to the room after server-side checks on revision, availability, exact dimensions, placement, and budget. Only use products returned by searchProducts.",
      inputSchema: z.object({
        summary: z.string(),
        additions: z.array(roomObjectSchema),
      }),
      execute: async ({ summary, additions }) => {
        const proposal: DesignProposal = {
          id: crypto.randomUUID(),
          roomId: state.get().id,
          baseRevision: state.get().revision,
          summary,
          additions,
        };
        try {
          const next = await ctx.runMutation(
            internal.rooms.applyDesignProposal,
            { roomId, proposal, brief: brief.get() },
          );
          state.set(next);
          return { ok: true as const, revision: next.revision };
        } catch (error) {
          return {
            ok: false as const,
            error:
              error instanceof Error
                ? error.message
                : "The proposal was rejected.",
          };
        }
      },
    }),
  };
}

async function runAgent(
  ctx: ActionCtx,
  roomId: Id<"rooms">,
  prompt: string,
  projectId: Id<"projects"> | null = null,
): Promise<{ text: string; room: RoomSnapshot }> {
  const doc = await ctx.runQuery(internal.rooms.getRoom, { roomId });
  if (!doc) throw new Error("This room does not exist.");
  let brief = doc.brief;
  let currentRoom = doc.snapshot;
  const tools = buildAgentTools(
    ctx,
    { get: () => currentRoom, set: (room) => (currentRoom = room) },
    roomId,
    { get: () => brief, set: (next) => (brief = next) },
    projectId,
  );
  const result = await generateText({
    model: openai(process.env.RUMI_AGENT_MODEL ?? "gpt-4o"),
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    stopWhen: stepCountIs(10),
  });
  return { text: result.text, room: currentRoom };
}

export const designRoom = internalAction({
  args: { roomId: v.id("rooms"), instruction: v.string() },
  handler: async (ctx, { roomId, instruction }) =>
    await runAgent(ctx, roomId, instruction),
});

export const runForProject = internalAction({
  args: { projectId: v.id("projects"), messageId: v.id("messages") },
  handler: async (ctx, { projectId, messageId }): Promise<void> => {
    const complete = (content: string, status: "done" | "error") =>
      ctx.runMutation(internal.messages.complete, {
        messageId,
        content,
        status,
      });
    try {
      const project: Doc<"projects"> | null = await ctx.runQuery(
        internal.projects.get,
        { projectId },
      );
      if (!project) throw new Error("This project does not exist.");
      const messages = await ctx.runQuery(internal.messages.history, {
        projectId,
      });
      const transcript = messages
        .filter((message) => message.status === "done")
        .slice(-10)
        .map(
          (message) =>
            `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
        )
        .join("\n");
      const { text } = await runAgent(
        ctx,
        project.roomId,
        `Conversation so far:\n${transcript}\n\nRespond to the user's latest message.`,
        projectId,
      );
      await complete(text, "done");
    } catch (error) {
      await complete(
        `Something went wrong: ${error instanceof Error ? error.message : "unknown error"}.`,
        "error",
      );
    }
  },
});
