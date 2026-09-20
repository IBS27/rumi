import { openai } from "@ai-sdk/openai";
import { streamText, stepCountIs, hasToolCall, tool, type ToolSet } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  roomObjectSchema,
  roomSchema,
  searchTaskSchema,
  type DesignBrief,
  type DesignProposal,
  type RoomSnapshot,
  type SearchTaskResult,
} from "../shared/contracts";
import { emptyBrief, normalizeBrief } from "./projects";
import { selectionTotal } from "../shared/budget";
import { findPlacement, placementIssue } from "../shared/geometry";

const SYSTEM_PROMPT = `You are the room designer for rumi. You build rooms from real web products.
- Start with getRoomContext. Respect owned and locked objects.
- A null room means no scan has been attached. Help establish the brief without inventing measurements, and invite the user to import a room when geometry is needed.
- Polygon rooms are real irregular scans. You can discuss them and search products, but automatic placement is not supported. Do not promise to place or move furniture in them.
- Work in meters and USD cents. Never infer dimensions that were not given.
- Inspiration-image messages include a visual analysis from a specialist model. Use its style, palette, material, lighting, and furniture cues, but never treat it as verified room geometry or exact dimensions.
- Save style, budget, and restrictions with updateBrief as soon as the user states them. A budget of 0 means no budget was specified.
- Never invent a budget or use a giant number as an unlimited budget. Unless the user explicitly gives a price or budget, keep budgetCents and search maxPriceCents at 0.
- Before searching, judge the full conversation, saved brief, and room context for ambiguity. A shopping request is very vague when it does not identify a concrete item, or when it lacks enough of these to search usefully: budget, size/clearance, style/color/material, intended use, or room placement.
- For a very vague request, you MUST call askOptions before searchProducts. Ask the single highest-impact missing question and offer 2-4 context-specific choices. Do not search, call another tool, or write a text reply in that turn. Wait for the user's option click or custom answer.
- Do not repeat information already present in the conversation, brief, or room. Do not force a clarification when the request and existing context already provide useful search constraints.
- You may also use askOptions for a useful design detail, room constraint, preference, priority, or tradeoff. Create choices that fit the current room and conversation; never use a fixed questionnaire. The user can type a custom answer in the card.
- Ask only one focused question per turn. Use a normal text question only when useful answers cannot be represented by 2-4 choices.
- Only propose products that searchProducts returned. Never invent ids, prices, or dimensions.
- Search returns one best candidate. The interface renders its name, image, price, merchant, and link as a product card. Let the card carry the recommendation: do not repeat its name, price, merchant, URL, description, or features in text. Do not write product lists, Markdown images, generic introductions, or offers of further assistance. Any accompanying text appears in expandable notes; keep it to one or two short sentences only for meaningful caveats, unmet constraints (such as faux leather instead of real leather), fit limitations, or a necessary next step. Never claim a constraint is met when it is not.
- If searchProducts reports that web search is not configured, say so and keep refining the brief instead of proposing products.
- Check the budget with checkBudget before proposeDesign.
- Validate each addition with validatePlacement before calling proposeDesign.
- proposeDesign applies additions atomically. A rejection returns an error you can fix and retry.`;

interface State<T> {
  get: () => T;
  set: (value: T) => void;
}

interface AgentActivity {
  id: string;
  tool: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
}

type ProgressSink = (
  content: string,
  activity: AgentActivity[],
  recommendationProductId: string | null,
) => Promise<void>;

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

function toolActivity(
  id: string,
  toolName: string,
  input: unknown,
): AgentActivity {
  const value = inputRecord(input);
  switch (toolName) {
    case "getRoomContext":
      return {
        id,
        tool: toolName,
        label: "Reading room context",
        status: "running",
      };
    case "updateBrief":
      return {
        id,
        tool: toolName,
        label: "Saving your preferences",
        status: "running",
      };
    case "searchProducts": {
      const query = typeof value.query === "string" ? value.query : "products";
      return {
        id,
        tool: toolName,
        label: `Searching for “${query.slice(0, 100)}”`,
        status: "running",
      };
    }
    case "getProductDetails": {
      const count = Array.isArray(value.ids) ? value.ids.length : 0;
      return {
        id,
        tool: toolName,
        label: count
          ? `Reviewing ${count} product${count === 1 ? "" : "s"}`
          : "Reviewing product details",
        status: "running",
      };
    }
    case "checkBudget":
      return {
        id,
        tool: toolName,
        label: "Checking the budget",
        status: "running",
      };
    case "validatePlacement": {
      const object = inputRecord(value.object);
      const name = typeof object.name === "string" ? object.name : null;
      return {
        id,
        tool: toolName,
        label: name
          ? `Checking placement for ${name.slice(0, 80)}`
          : "Checking room placement",
        status: "running",
      };
    }
    case "proposeDesign": {
      const count = Array.isArray(value.additions) ? value.additions.length : 0;
      return {
        id,
        tool: toolName,
        label: count
          ? `Applying ${count} design item${count === 1 ? "" : "s"}`
          : "Applying the design",
        status: "running",
      };
    }
    case "askOptions":
      return {
        id,
        tool: toolName,
        label: "Preparing a follow-up question",
        status: "running",
      };
    default:
      return {
        id,
        tool: toolName,
        label: `Using ${toolName.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`,
        status: "running",
      };
  }
}

function buildAgentTools(
  ctx: ActionCtx,
  state: State<RoomSnapshot | null>,
  roomId: Id<"rooms"> | null,
  brief: State<DesignBrief>,
  projectId: Id<"projects"> | null,
  recommendation: State<string | null>,
): ToolSet {
  return {
    ...(projectId
      ? {
          askOptions: tool({
            description:
              "Pause the conversation and render an interactive clarification card with 2-4 concrete options plus a custom-answer field. Use this before searching when the request is too vague, or when one focused design choice would materially improve the result. End your turn after calling it.",
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
        "Save only design preferences the user stated. Set budgetCents only from an explicit user price; use 0 when no budget was specified and never invent a ceiling.",
      inputSchema: z.object({
        prompt: z.string().optional(),
        styles: z.array(z.string()).optional(),
        budgetCents: z.number().int().nonnegative().optional(),
        restrictions: z.array(z.string()).optional(),
      }),
      execute: async (patch) => {
        const next = projectId
          ? await ctx.runMutation(internal.projects.updateBrief, {
              projectId,
              ...patch,
            })
          : roomId
            ? await ctx.runMutation(internal.rooms.patchBrief, {
                roomId,
                ...patch,
              })
            : brief.get();
        brief.set(next);
        return next;
      },
    }),
    searchProducts: tool({
      description:
        "Search the web for one concrete furniture item. Returns the best candidate with price, dimensions, source URL, score breakdown, and extraction failures. Use maxPriceCents 0 unless the user explicitly stated a budget. Derive footprint, height, style, and palette from the room and brief. Put any other requested specifications into miscellaneous as short phrases.",
      inputSchema: searchTaskSchema,
      execute: async (task): Promise<SearchTaskResult> => {
        try {
          const result = await ctx.runAction(internal.search.searchProducts, {
            task,
          });
          recommendation.set(result.candidates[0]?.product.id ?? null);
          return result;
        } catch (error) {
          recommendation.set(null);
          return {
            category: task.category,
            query: task.query,
            candidates: [],
            explanation: process.env.EXA_API_KEY
              ? "Product search is unavailable right now. Please try again later."
              : "Web search is not configured in this deployment yet.",
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
        const room = state.get();
        const ids = (room?.objects ?? [])
          .map((object) => object.productId)
          .filter((id): id is string => id !== null);
        const products = await ctx.runQuery(internal.products.getByIds, {
          ids,
        });
        const budgetCents = brief.get().budgetCents;
        try {
          const totalCents = room ? selectionTotal(room, products) : 0;
          return {
            budgetCents: budgetCents > 0 ? budgetCents : null,
            totalCents,
            remainingCents: budgetCents > 0 ? budgetCents - totalCents : null,
          };
        } catch {
          return {
            budgetCents: budgetCents > 0 ? budgetCents : null,
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
        const room = state.get();
        if (!room)
          return { issue: "Import a room scan before checking placement." };
        const issue = placementIssue(room, object);
        if (!issue) return { issue: null };
        if (!object.productId) return { issue };
        const products = await ctx.runQuery(internal.products.getByIds, {
          ids: [object.productId],
        });
        const suggested = products[0] ? findPlacement(room, products[0]) : null;
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
        const room = state.get();
        if (!room || !roomId)
          return { ok: false as const, error: "Import a room scan first." };
        const proposal: DesignProposal = {
          id: crypto.randomUUID(),
          roomId: room.id,
          baseRevision: room.revision,
          summary,
          additions,
        };
        try {
          const next = await ctx.runMutation(
            internal.rooms.applyDesignProposal,
            { roomId, proposal },
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
  roomId: Id<"rooms"> | null,
  prompt: string,
  projectId: Id<"projects"> | null = null,
  progress?: ProgressSink,
  initialActivity: AgentActivity[] = [
    {
      id: "planning",
      tool: "planning",
      label: "Planning",
      status: "running",
    },
  ],
): Promise<{ text: string; room: RoomSnapshot | null }> {
  const doc = roomId
    ? await ctx.runQuery(internal.rooms.getRoom, { roomId })
    : null;
  const project = projectId
    ? await ctx.runQuery(internal.projects.get, { projectId })
    : null;
  if (!doc && !project) throw new Error("This project does not exist.");
  let brief = normalizeBrief(doc?.brief ?? project?.brief ?? emptyBrief());
  let currentRoom: RoomSnapshot | null = doc?.snapshot ?? null;
  let recommendationProductId: string | null = null;
  const tools = buildAgentTools(
    ctx,
    { get: () => currentRoom, set: (room) => (currentRoom = room) },
    roomId,
    { get: () => brief, set: (next) => (brief = next) },
    projectId,
    {
      get: () => recommendationProductId,
      set: (next) => (recommendationProductId = next),
    },
  );
  const result = streamText({
    model: openai(process.env.RUMI_AGENT_MODEL ?? "gpt-4o"),
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    stopWhen: [stepCountIs(10), hasToolCall("askOptions")],
    abortSignal: AbortSignal.timeout(110000),
  });
  let streamedText = "";
  let activity = initialActivity.map((item) => ({ ...item }));
  let lastPublished = 0;
  let step = 0;
  const finish = (predicate: (item: AgentActivity) => boolean) => {
    activity = activity.map((item) =>
      item.status === "running" && predicate(item)
        ? { ...item, status: "done" }
        : item,
    );
  };
  const publish = async (force = false) => {
    if (!progress) return;
    const now = Date.now();
    if (!force && now - lastPublished < 150) return;
    lastPublished = now;
    await progress(streamedText, activity, recommendationProductId);
  };
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        step++;
        finish((item) => item.tool === "responding");
        if (step > 1) {
          activity.push({
            id: `planning-${step}`,
            tool: "planning",
            label: "Planning next step",
            status: "running",
          });
          await publish(true);
        }
        break;
      case "text-delta":
        finish((item) => item.tool === "planning");
        if (
          !activity.some(
            (item) => item.tool === "responding" && item.status === "running",
          )
        )
          activity.push({
            id: `responding-${step}`,
            tool: "responding",
            label: "Writing response",
            status: "running",
          });
        streamedText += part.text;
        await publish();
        break;
      case "tool-call":
        finish(
          (item) => item.tool === "planning" || item.tool === "responding",
        );
        activity.push(toolActivity(part.toolCallId, part.toolName, part.input));
        await publish(true);
        break;
      case "tool-result":
        finish((item) => item.id === part.toolCallId);
        await publish(true);
        break;
      case "tool-error":
        activity = activity.map((item) =>
          item.id === part.toolCallId
            ? { ...item, status: "error" as const }
            : item,
        );
        await publish(true);
        break;
      case "error":
        throw part.error;
    }
  }
  finish(() => true);
  const text = await result.text;
  streamedText = text;
  await publish(true);
  return { text, room: currentRoom };
}

export const designRoom = internalAction({
  returns: v.object({
    text: v.string(),
    room: v.union(zodToConvex(roomSchema), v.null()),
  }),
  args: { roomId: v.id("rooms"), instruction: v.string() },
  handler: async (ctx, { roomId, instruction }) =>
    await runAgent(ctx, roomId, instruction),
});

export const runForProject = internalAction({
  returns: v.null(),
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
      if (!project || project.activeMessageId !== messageId) return;
      if (!process.env.OPENAI_API_KEY)
        throw new Error(
          "Chat is not configured yet. Add the OpenAI API key to the development deployment.",
        );
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
      const reply = messages.find((message) => message._id === messageId);
      const { text } = await runAgent(
        ctx,
        project.roomId ?? null,
        `Conversation so far:\n${transcript}\n\nRespond to the user's latest message.`,
        projectId,
        async (content, activity, recommendationProductId) => {
          await ctx.runMutation(internal.messages.updateProgress, {
            messageId,
            content,
            activity,
            recommendationProductId,
          });
        },
        reply?.activity ?? undefined,
      );
      await complete(text, "done");
    } catch (error) {
      console.error(
        "Chat reply failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      await complete(
        "I couldn’t finish that reply. Please try again.",
        "error",
      );
    }
  },
});
