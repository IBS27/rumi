import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  roomObjectSchema,
  searchTaskSchema,
  type DesignProposal,
  type RoomSnapshot,
} from "../shared/contracts";
import { selectionTotal } from "../shared/budget";
import { findPlacement, placementIssue } from "../shared/geometry";

const SYSTEM_PROMPT = `You are the room designer for rumi. You build rooms from real web products.
- Start with getRoomContext. Respect owned and locked objects.
- Work in meters and USD cents. Never infer dimensions that were not given.
- Only propose products that searchProducts returned. Never invent ids, prices, or dimensions.
- Check the budget with checkBudget before proposeDesign.
- Validate each addition with validatePlacement before calling proposeDesign.
- When searchProducts reports failures, relax the request or explain the gap.
- proposeDesign applies additions atomically. A rejection returns an error you can fix and retry.`;

export const designRoom = internalAction({
  args: { roomId: v.id("rooms"), instruction: v.string() },
  handler: async (
    ctx,
    { roomId, instruction },
  ): Promise<{ text: string; room: RoomSnapshot }> => {
    const doc = await ctx.runQuery(internal.rooms.getRoom, { roomId });
    if (!doc) throw new Error("This room does not exist.");
    const brief = doc.brief;
    let currentRoom = doc.snapshot;
    const tools = {
      getRoomContext: tool({
        description:
          "Return the room snapshot (dimensions, openings, placed objects) and the design brief.",
        inputSchema: z.object({}),
        execute: async () => ({ room: currentRoom, brief }),
      }),
      searchProducts: tool({
        description:
          "Search the web for one furniture category. Returns validated products with prices, dimensions, and source URLs, plus failures for dropped candidates. Derive maxPriceCents and maxFootprint from the room and budget, not guesses.",
        inputSchema: searchTaskSchema,
        execute: async (task) =>
          await ctx.runAction(internal.search.searchProducts, { task }),
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
          const ids = currentRoom.objects
            .map((object) => object.productId)
            .filter((id): id is string => id !== null);
          const products = await ctx.runQuery(internal.products.getByIds, {
            ids,
          });
          try {
            const totalCents = selectionTotal(currentRoom, products);
            return {
              budgetCents: brief.budgetCents,
              totalCents,
              remainingCents: brief.budgetCents - totalCents,
            };
          } catch {
            return {
              budgetCents: brief.budgetCents,
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
          const issue = placementIssue(currentRoom, object);
          if (!issue) return { issue: null };
          if (!object.productId) return { issue };
          const products = await ctx.runQuery(internal.products.getByIds, {
            ids: [object.productId],
          });
          const suggested = products[0]
            ? findPlacement(currentRoom, products[0])
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
            roomId: currentRoom.id,
            baseRevision: currentRoom.revision,
            summary,
            additions,
          };
          try {
            const next = await ctx.runMutation(
              internal.rooms.applyDesignProposal,
              { roomId, proposal, brief },
            );
            currentRoom = next;
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
    const result = await generateText({
      model: openai(process.env.RUMI_AGENT_MODEL ?? "gpt-4o"),
      system: SYSTEM_PROMPT,
      prompt: instruction,
      tools,
      stopWhen: stepCountIs(10),
    });
    return { text: result.text, room: currentRoom };
  },
});
