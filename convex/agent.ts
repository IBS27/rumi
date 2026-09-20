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
  projectPhaseSchema,
  roomObjectSchema,
  roomSchema,
  searchTaskSchema,
  specTopicSchema,
  wantSchema,
  type DesignBrief,
  type DesignPlan,
  type DesignProposal,
  type ProjectPhase,
  type RoomSnapshot,
  type SearchTaskResult,
  type ZoneFill,
} from "../shared/contracts";
import { emptyBrief, normalizeBrief } from "./projects";
import { proposeZones, removedPlacementHints } from "./planner";
import { selectionTotal } from "../shared/budget";
import {
  designPlacementIssue,
  suggestPlacement,
  designCommandsSchema,
} from "../shared/design";
import { evaluateFill } from "../shared/planner";
import { freeArea } from "../shared/planner/space";
import { choiceListToCard } from "../shared/chat/choices";
import {
  SPEC_SUMMARY_OPTIONS,
  specStatus,
  specStatusLine,
  specSummaryText,
} from "../shared/chat/spec";
import { shouldForcePlanSpace } from "../shared/chat/planning";

const SYSTEM_PROMPT = `You are the room designer for rumi. You build rooms from real web products.
- Start with getRoomContext. Respect owned and locked objects.
- A null room means no scan has been attached. Help establish the brief without inventing measurements, and invite the user to import a room when geometry is needed.
- Scanned polygon rooms support validated placement. Use reserved zones when adding planned products; never invent room boundaries or product dimensions. Edits are applied to the room on screen.
- Work in meters and USD cents. Never infer dimensions that were not given. In layout coordinates, north/back decreases Z, south/front increases Z, west/left decreases X, east/right increases X. A relative move adjusts the existing position by the requested distance. For existing items use editDesign move with the exact object ID and adjusted position; keep its Y coordinate and rotation unless asked otherwise. Do not reconstruct dimensions or invent a new object to move an existing item.
- Inspiration-image messages include a visual analysis from a specialist model. Use its style, palette, material, lighting, and furniture cues, but never treat it as verified room geometry or exact dimensions.
- Save style, budget, and restrictions with updateBrief as soon as the user states them. A budget of 0 means no budget was specified.
- Never invent a budget or use a giant number as an unlimited budget. Unless the user explicitly gives a price or budget, keep budgetCents and search maxPriceCents at 0.
- Convert dollars to integer cents when saving a budget: $200 is 20000 cents, not 200.
- The latest user request overrides earlier shopping requirements. In EVERY stage, if they drop or change an item, first call updateBrief with the complete revised wants list, preserving unrelated wants. "Without the painting" removes art/painting/poster wants. Save an exclusion in restrictions so it is not suggested again. If they say "leave it be", "never mind", or otherwise stop shopping, save the revised brief, acknowledge it, and END the turn. Do not call planSpace, fillZones, or ask for confirmation to stop. An empty wants list after cancellation is not permission to furnish the whole room.
- Save excluded furniture categories in updateBrief.excludedCategories, not only in free-text restrictions. "I do not need the bed" excludes bed and removes any bed want, but does not change the bedroom purpose or remove an existing bed. Explicit exclusions override room-defining defaults: a bedroom plan CAN omit a bed. Preserve all other exclusions; remove an exclusion (and its old restriction) only when the user requests that item again. If they say "go for it" after excluding the bed, plan the remaining furniture without asking about a smaller bed.
- "Remove art from the plan" changes shopping requirements, not existing room objects. Never remove a mirror or other owned object for that instruction. Retain other requests from the conversation, such as plants, even if a prior turn failed to save them. Continue planning those retained requests after saving the corrected brief.

Editing an existing layout takes priority over the intake stages below. In EVERY stage, including Spec, immediately perform an explicit request to move, keep, remove, replace or place an existing/recommended item with getRoomContext and editDesign. Do not require purpose, style, accessories, a spec summary or a new plan to make these edits. Ask only if the requested edit itself is ambiguous or unsafe. End with the actual edit result; do not restart intake questions after a successful edit. The intake stages apply to planning and shopping for a new design.

The project moves through stages. The current stage is given at the top of the conversation.

Stage 1, Spec. Build the brief; do not search or plan.
- Five topics must be decided, in this order: purpose, style, items, accessories, budget. Restrictions are optional; save them when stated. A "Spec status" line at the top of the conversation tells you which topics are decided; trust it and never ask about a decided topic again.
- Save everything the user reveals the moment they say it, before asking anything, even in passing: "something cozy" is a style (styles: ["cozy"]); "it's my bedroom" is the purpose; "I need a desk" is an item. Then the status line will show that topic decided and you skip its question.
- Answers that leave a field empty still decide the topic: when the user says you choose the items, save decided including "items"; when they say no budget yet, save decided including "budget". Always send the full decided list.
- Every choice you offer MUST be an askOptions card. Never write numbered, lettered, or bulleted choices in plain text; the user cannot click text. One card per turn, 2-4 options, and end your turn after it. Any text before the card is one or two sentences at most; the question itself goes in the card, not in the text.
- Set multiSelect true when more than one answer can apply at once (styles to blend, materials, several items they want, restrictions); leave it false when exactly one answer is expected (purpose, budget range, accessories).
- Ask only for the first missing topic in the status line.
  - Purpose: "What is this room for?" with choices such as Bedroom, Living room, Home office, Dining room. Save to purpose.
  - Style: ask only if no style, palette, or inspiration image has been given. Offer 3-4 directions that suit the room.
  - Items: "Anything specific you want in here, or should I choose what fits the space?" with choices like "You choose", "I have a list". If they list items, save them to wants (category plus short notes such as "seats two", "under 1.2 m wide"). If they say you choose, leave wants empty.
  - Accessories: "Should I include accessories like art, a rug, and lamps?" with choices Include accessories / Furniture only / You decide. Save include, skip, or unspecified.
  - Budget: "Do you have a budget for this room?" with 3 ranges that suit the purpose and item count (for example Under $1,500 / $1,500–4,000 / $4,000–8,000) plus "No budget yet". When they pick a range, save its upper bound as budgetCents; a custom amount is saved as typed; "No budget yet" keeps 0. This is the only way a budget may be set without the user naming a number.
- When inspiration images arrive, merge their analysis into palette, materials, styles, and a short inspiration summary via updateBrief. Never treat an image as room geometry.
- When the status line says everything is decided, call showSpecSummary. It renders the brief read-only with the buttons Start planning and Modify details; never build the summary yourself, and never put brief facts into askOptions options. End your turn.
- If the user picks Modify details, ask in one short sentence what they want to change (no card). If they type a change (for example "add a desk"), save it with updateBrief, then call showSpecSummary again.
- Clicking Start planning on the summary card moves the stage to Plan by itself; you will see "Current stage: plan". If the user says "start planning" in words while still in Spec, call setPhase('plan'). Planning needs an attached room; if none, ask them to import one and stay in Spec.
- Do not call showSpecSummary twice in a row without a change in between.
- Planning and shopping for a new design must wait until Spec is complete. Targeted replacement searches for existing selected products are allowed immediately; pass replacementObjectId when known, or search its existing category.

Stage 2, Plan. Reserve space, show the plan, then shop what the user keeps.
- Before planning, save any changed requested items with updateBrief. The planner reads the saved wants, not just your instruction. If a planner error mentions a canceled item, reconcile the brief before retrying. Never describe a category/scope/schema error as lack of physical space.
- Call planSpace once with a one-sentence instruction. When the user named items, each gets a zone and the planner may add one floor piece plus accessories per their answer; when they left it to you, the planner chooses the pieces from the room's purpose, style, and free space, and sets spacing (airy, balanced, cozy) from the style.
- planSpace shows the user a plan card listing every zone (what, where, footprint, suggested or not) and what did not fit. Your turn ends there; do not describe the zones in text and do not call fillZones in the same turn.
- The user trims the card and confirms; their next message says which items to search. Then call fillZones with no arguments. It runs one search per kept item, all at once, and the interface shows one product card per zone with its fit (yes, no, unknown). Keep your text to unmet constraints or a necessary next step. Products without dimensions are excluded.
- planSpace may reject zones that do not fit. Never squeeze furniture into space the plan rejected; if the user asks about a rejected piece, explain the reason from the card.
- If planning fails for a room-defining piece and the user says it fit before, asks for a smaller size, or approves placing it close to existing furniture, call planSpace again immediately with that placement fact. Do not ask them to choose between a smaller footprint and another anchor; the geometry search tries wall, obstacle-aligned, open-floor, and smaller standard-size placements itself.
- Use searchProducts directly only when the user asks for one specific item outside the plan.
- When every kept zone has a product, call setPhase('review'). If the user wants to change the brief, call setPhase('spec').
- Products without complete dimensions must never be recommended. Search automatically tries alternatives; if it returns no candidates, explain that no suitable product was found and offer to broaden the search.
- Only propose products that searchProducts or fillZones returned. Never invent ids, prices, or dimensions.
- Search returns one best candidate. The interface renders its name, image, price, merchant, and link as a product card. Let the card carry the recommendation: do not repeat its name, price, merchant, URL, description, or features in text. Do not write product lists, Markdown images, generic introductions, or offers of further assistance. Any accompanying text appears in expandable notes; keep it to one or two short sentences only for meaningful caveats, unmet constraints (such as faux leather instead of real leather), fit limitations, or a necessary next step. Never claim a constraint is met when it is not.
- If searchProducts reports that web search is not configured, say so and keep refining the brief instead of proposing products.
- Check the budget with checkBudget before proposeDesign.
- Validate each addition with validatePlacement before calling proposeDesign.
- proposeDesign applies additions atomically. A rejection returns an error you can fix and retry.
- For changes to the existing room, use editDesign. It supports add, move, remove, replace and lock in one atomic batch. Do not call correct; it is reserved for user measurement corrections. Use product IDs from search or current recommendations. Use unique instance IDs for additions and the complete reserved zone from getRoomContext where available.
- getRoomContext includes the selected object. Resolve "this" or "that lamp" to its exact ID. If ambiguous, ask. Keep productLocked products and locked placements unchanged. You may lock a choice when asked; never unlock it. Preserve owned objects unless the user explicitly asks to move or remove them.
- If the user asks to save an amount, call checkBudget first, compute a target from the current selection total minus that amount, then search replacements with ceilings that meet that target. Set maxTotalCents on editDesign to enforce it. Explain savings from actual prices. Batch replacements together so intermediate budgets do not reject a valid final design.
- Once products are found, offer placing them. When the user asks to furnish or apply the found design, call editDesign to add them at their reserved zones. Never say an item is placed until the mutation succeeds. A failed change leaves the room intact; explain the issue, refresh context and retry only a suitable alternative.
- For natural-language placement such as "put it in a good spot near the bed", use editDesign add with nearObjectId and NO position for an unplaced product, or arrange with objectId and optional nearObjectId for a product already in the room. Code chooses a validated location and puts small plants and tabletop decor on a supporting surface. Do not ask the user for coordinates or invent them. Use move only for an explicit precise movement. Never lock a product or its placement unless the user explicitly asks to keep or lock it. Placing an item does not authorize a lock. Do not describe a size preview as a finished model.
- For a requested replacement, searchProducts accepts replacementObjectId. Supply the existing unkept object ID; this targeted replacement search is allowed in any stage.
- A product's variant fixes its appearance and measurements. To make a design warmer, search appropriate replacement finishes/products while preserving kept choices.`;

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
  recommendations: ZoneFill[] | null,
) => Promise<void>;

// Lets a tool report sub-steps (one row per searched item) while it runs.
interface Reporter {
  push: (item: AgentActivity) => Promise<void>;
  finish: (id: string, status?: "done" | "error") => Promise<void>;
}

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
    case "planSpace":
      return {
        id,
        tool: toolName,
        label: "Measuring free space and reserving zones",
        detail: "planning the layout, about 20 seconds",
        status: "running",
      };
    case "fillZones": {
      const count = Array.isArray(value.zoneIds) ? value.zoneIds.length : 0;
      return {
        id,
        tool: toolName,
        label: count
          ? `Searching ${count} reserved zone${count === 1 ? "" : "s"} at once`
          : "Searching reserved zones",
        detail: "reading retailer pages and checking sizes, about a minute",
        status: "running",
      };
    }
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
  plan: State<DesignPlan | null>,
  phase: State<ProjectPhase>,
  fills: State<ZoneFill[] | null>,
  report: Reporter,
  messageId: Id<"messages"> | null,
  selectedObjectId: string | null,
): ToolSet {
  const specGate = () =>
    phase.get() === "spec"
      ? {
          ok: false as const,
          error:
            "The project is still in Spec. Finish the brief, show the spec summary with askOptions (Start planning / Keep refining), and call setPhase('plan') only after the user confirms.",
        }
      : null;
  return {
    planSpace: tool({
      description:
        "Measure the attached room's free floor space and reserve zones for the furniture it still needs, with clearance margins around doors and existing pieces. Shows the user a plan card listing the zones so they can drop items before anything is searched; your turn ends when it succeeds. Requires an attached room.",
      inputSchema: z.object({
        instruction: z
          .string()
          .describe(
            "What the user wants for the room, in one or two sentences.",
          ),
      }),
      execute: async ({ instruction }) => {
        const gated = specGate();
        if (gated) return gated;
        const room = state.get();
        if (!room || !roomId)
          return {
            ok: false as const,
            error: "Attach or import a room before planning the space.",
          };
        const ids = room.objects
          .map((object) => object.productId)
          .filter((id): id is string => id !== null);
        const products = await ctx.runQuery(internal.products.getByIds, {
          ids,
        });
        try {
          const roomDoc = await ctx.runQuery(internal.rooms.getRoom, { roomId });
          const result = await proposeZones(
            room,
            brief.get(),
            products,
            instruction,
            "",
            removedPlacementHints(room, roomDoc?.history ?? []),
          );
          plan.set(result.plan);
          if (projectId)
            await ctx.runMutation(internal.plans.propose, {
              projectId,
              roomId,
              plan: result.plan,
            });
          return {
            ok: true as const,
            cardShown: Boolean(projectId),
            note: projectId
              ? "The plan card is shown to the user. End your turn now; they will choose which items to search."
              : undefined,
            summary: result.plan.summary,
            spacing: result.plan.spacing,
            freeAreaSquareMeters:
              Math.round(freeArea(result.model) * 100) / 100,
            zones: result.plan.zones.map((zone) => ({
              id: zone.id,
              purpose: zone.purpose,
              category: zone.category,
              query: zone.query,
              mount: zone.mount,
              suggested: zone.suggested,
              hostId: zone.relatedObjectId,
              position: zone.position,
              rotationY: zone.rotationY,
              footprint: zone.footprint,
              maxHeight: zone.maxHeight,
              margins: zone.margins,
              priority: zone.priority,
            })),
            rejected: result.plan.rejected,
            warnings: result.model.warnings,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : "Planning failed.",
          };
        }
      },
    }),
    fillZones: tool({
      description:
        "Search the web for the items the user kept on the plan card: one search per item, all at once. Returns per zone: the product (if any), whether it fits the reserved footprint, and any issues. The interface renders one product card per zone. Call this after the user confirms the plan card.",
      inputSchema: z.object({
        zoneIds: z
          .array(z.string())
          .max(8)
          .optional()
          .describe(
            "Zone ids to search. Leave empty to search exactly the items the user kept on the plan card.",
          ),
      }),
      execute: async ({ zoneIds }) => {
        const gated = specGate();
        if (gated) return gated;
        let current = plan.get();
        let selectedIds = zoneIds ?? [];
        let planId: Id<"plans"> | null = null;
        if (projectId) {
          const stored = await ctx.runQuery(internal.plans.active, {
            projectId,
          });
          if (stored) {
            current = stored.plan;
            planId = stored._id;
            if (!selectedIds.length && stored.selectedZoneIds)
              selectedIds = stored.selectedZoneIds;
            if (stored.status === "proposed")
              return {
                ok: false as const,
                error:
                  "The user has not confirmed the plan card yet. End your turn and wait for their choice.",
              };
          }
        }
        if (!current)
          return {
            ok: false as const,
            error: "Call planSpace before fillZones.",
          };
        if (!selectedIds.length)
          selectedIds = current.zones.map((zone) => zone.id);
        const selected = current.zones
          .map((zone, index) => ({ zone, task: current!.tasks[index] }))
          .filter(({ zone }) => selectedIds.includes(zone.id));
        if (selected.length === 0)
          return {
            ok: false as const,
            error: "No reserved zones match those ids.",
          };
        try {
          // One search action per item, all at once. Each runAction has its
          // own memory, so the searches do not share one action's limit, and
          // the wait is one search long instead of one per item.
          const results: (ZoneFill & {
            product: SearchTaskResult["candidates"][number]["product"] | null;
            explanation: string;
          })[] = await Promise.all(
            selected.map(async ({ zone, task }) => {
              const rowId = `search-${zone.id}`;
              await report.push({
                id: rowId,
                tool: "searchProducts",
                label: `Searching: ${zone.category}`,
                detail: zone.query,
                status: "running",
              });
              try {
                const result: SearchTaskResult = await ctx.runAction(
                  internal.search.searchProducts,
                  { task },
                );
                const product = result.candidates[0]?.product ?? null;
                await report.finish(rowId, product ? "done" : "error");
                return {
                  ...evaluateFill(zone, product),
                  product,
                  explanation: result.explanation,
                };
              } catch (error) {
                await report.finish(rowId, "error");
                return {
                  ...evaluateFill(zone, null),
                  product: null,
                  explanation:
                    error instanceof Error ? error.message : "search failed",
                };
              }
            }),
          );
          fills.set(
            results.map(({ zoneId, productId, fits, issues }) => ({
              zoneId,
              productId,
              fits,
              issues,
            })),
          );
          if (planId)
            await ctx.runMutation(internal.plans.setStatus, {
              planId,
              status: "searched",
            });
          return {
            ok: true as const,
            note: "One product card per zone is shown to the user. Keep your text to caveats only.",
            fills: results,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: process.env.EXA_API_KEY
              ? "Product search is unavailable right now. Please try again later."
              : "Web search is not configured in this deployment yet.",
            detail: error instanceof Error ? error.message : "search failed",
          };
        }
      },
    }),
    ...(projectId
      ? {
          showSpecSummary: tool({
            description:
              "Show the finished brief as a read-only summary card with two buttons, Start planning and Modify details, plus a free-text field. Call this when every Spec topic is decided. End your turn after it.",
            inputSchema: z.object({}),
            execute: async () => {
              const status = specStatus(brief.get());
              if (!status.complete)
                return {
                  ok: false as const,
                  error: `Not every topic is decided yet. Still to ask: ${status.missing.join(", ")}.`,
                };
              await ctx.runMutation(internal.messages.ask, {
                projectId,
                question: specSummaryText(brief.get()),
                options: SPEC_SUMMARY_OPTIONS,
                multiSelect: false,
              });
              return {
                ok: true as const,
                note: "Summary shown. End your turn and wait for Start planning, Modify details, or a typed change.",
              };
            },
          }),
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
    editDesign: tool({
      description:
        "Apply additions, moves, replacements, removals and locks to the visible room atomically. Include reserved zones for planned products. maxTotalCents enforces an explicit savings target. Locked choices cannot be changed. Errors leave the room unchanged.",
      inputSchema: z.object({
        commands: designCommandsSchema,
        maxTotalCents: z.number().int().nonnegative().optional(),
      }),
      execute: async ({ commands, maxTotalCents }) => {
        const room = state.get();
        if (!projectId || !messageId || !room)
          return { ok: false, error: "Attach a room first." };
        try {
          const next = await ctx.runMutation(internal.design.editByAgent, {
            projectId,
            messageId,
            expectedRevision: room.revision,
            commands,
            maxTotalCents,
          });
          state.set(next);
          return { ok: true, revision: next.revision, objects: next.objects };
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error ? error.message : "The edit was rejected.",
          };
        }
      },
    }),
    getRoomContext: tool({
      description:
        "Return the room snapshot (dimensions, openings, placed objects) and the design brief.",
      inputSchema: z.object({}),
      execute: async () => {
        const design = projectId
          ? await ctx.runQuery(internal.design.getForAgent, { projectId })
          : null;
        if (design) {
          state.set(design.room);
          brief.set(design.brief);
        }
        return {
          room: state.get(),
          brief: brief.get(),
          selectedObjectId,
          products: design?.products ?? [],
          recommendations: design?.recommendations ?? [],
        };
      },
    }),
    setPhase: tool({
      description:
        "Move the project between stages. Use 'plan' only after the user confirmed the spec summary (clicked Start planning or said so). Use 'spec' to go back and refine when the user asks. Use 'review' once every reserved zone has a product.",
      inputSchema: z.object({ phase: projectPhaseSchema }),
      execute: async ({ phase: next }) => {
        if (next === "plan" && !state.get())
          return {
            ok: false as const,
            error:
              "Planning needs a room. Ask the user to attach or import a room first.",
          };
        if (projectId)
          await ctx.runMutation(internal.projects.setPhase, {
            projectId,
            phase: next,
          });
        phase.set(next);
        return { ok: true as const, phase: next };
      },
    }),
    updateBrief: tool({
      description:
        "Save only design preferences the user stated or that inspiration images showed. Set budgetCents only from an explicit user price; use 0 when no budget was specified and never invent a ceiling. purpose is what the room is for. wants lists the items the user asked for (category plus short notes); replace the whole list when it changes, and leave it empty when they want you to choose. accessories is include, skip, or unspecified. palette holds color families in words (black, navy blue, warm grey), never hex; materials holds short words like oak, linen, brass. inspiration is your merged summary of the analyzed images.",
      inputSchema: z.object({
        prompt: z.string().optional(),
        styles: z.array(z.string()).optional(),
        budgetCents: z.number().int().nonnegative().optional(),
        restrictions: z.array(z.string()).optional(),
        palette: z
          .array(z.string().max(40))
          .max(8)
          .optional()
          .describe(
            "Color families in plain words, such as 'black', 'navy blue', 'warm grey', 'natural oak'. Never hex codes.",
          ),
        materials: z.array(z.string()).max(12).optional(),
        purpose: z.string().max(80).optional(),
        wants: z.array(wantSchema).max(12).optional().describe(
          "The complete current shopping list. Remove canceled items immediately, including art when the user says without the painting. An empty array clears all previous wants.",
        ),
        excludedCategories: z.array(z.string().trim().min(1).max(80)).max(12).optional().describe(
          "Complete list of furniture categories the user does not want to shop for, such as bed. Overrides room-purpose defaults. Preserve unrelated exclusions; clear a category when the user requests it again.",
        ),
        accessories: z.enum(["unspecified", "include", "skip"]).optional(),
        inspiration: z.string().max(1200).optional(),
        decided: z
          .array(specTopicSchema)
          .optional()
          .describe(
            "Spec topics the user has now answered, including answers that leave the field empty: 'items' when they said you choose, 'budget' when they said no budget yet. Send the full list.",
          ),
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
      inputSchema: searchTaskSchema.extend({
        replacementObjectId: z
          .string()
          .optional()
          .describe(
            "The existing object being replaced, for targeted edits during any stage.",
          ),
      }),
      execute: async ({
        replacementObjectId,
        ...task
      }): Promise<SearchTaskResult> => {
        const replacement = state
          .get()
          ?.objects.find(
            (object) =>
              !object.productLocked &&
              (replacementObjectId
                ? object.id === replacementObjectId
                : Boolean(object.productId) &&
                  object.category === task.category),
          );
        const gated =
          replacement && !replacement.productLocked ? null : specGate();
        if (gated)
          return {
            category: task.category,
            query: task.query,
            candidates: [],
            explanation: gated.error,
            failures: [{ stage: "search", detail: "spec phase" }],
          };
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
        const issue = designPlacementIssue(room, object);
        if (!issue) return { issue: null };
        const suggested = suggestPlacement(room, object);
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
          const next =
            projectId && messageId
              ? await ctx.runMutation(internal.design.editByAgent, {
                  projectId,
                  messageId,
                  expectedRevision: room.revision,
                  commands: additions.map((object) => ({
                    type: "add" as const,
                    productId: object.productId ?? "",
                    instanceId: object.id,
                    position: object.position,
                    rotationY: object.rotation.y,
                  })),
                })
              : await ctx.runMutation(internal.rooms.applyDesignProposal, {
                  roomId,
                  proposal,
                });
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
  selectedObjectId: string | null = null,
  forcePlanSpace = false,
): Promise<{
  text: string;
  room: RoomSnapshot | null;
  askedOptions: boolean;
}> {
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
  let zoneFills: ZoneFill[] | null = null;
  let currentPlan: DesignPlan | null = null;
  // A room-only chat (no project) has no stage gate.
  let currentPhase: ProjectPhase = project ? (project.phase ?? "spec") : "plan";
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
    await progress(streamedText, activity, recommendationProductId, zoneFills);
  };
  const report: Reporter = {
    push: async (item) => {
      activity.push(item);
      await publish(true);
    },
    finish: async (id, status = "done") => {
      activity = activity.map((item) =>
        item.id === id ? { ...item, status } : item,
      );
      await publish(true);
    },
  };
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
    { get: () => currentPlan, set: (next) => (currentPlan = next) },
    { get: () => currentPhase, set: (next) => (currentPhase = next) },
    { get: () => zoneFills, set: (next) => (zoneFills = next) },
    report,
    project?.activeMessageId ?? null,
    selectedObjectId,
  );
  const result = streamText({
    model: openai(process.env.RUMI_AGENT_MODEL ?? "gpt-4o"),
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    prepareStep: forcePlanSpace
      ? ({ stepNumber }) =>
          stepNumber === 0
            ? {
                activeTools: ["planSpace"],
                toolChoice: {
                  type: "tool" as const,
                  toolName: "planSpace" as const,
                },
              }
            : undefined
      : undefined,
    stopWhen: [
      stepCountIs(10),
      hasToolCall("askOptions"),
      hasToolCall("showSpecSummary"),
      // A shown plan card ends the turn; the user chooses what to search.
      ({ steps }) =>
        steps
          .at(-1)
          ?.toolResults.some(
            (item) =>
              item.toolName === "planSpace" &&
              typeof item.output === "object" &&
              item.output !== null &&
              (item.output as { cardShown?: boolean }).cardShown === true,
          ) ?? false,
    ],
    abortSignal: AbortSignal.timeout(110000),
  });
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
  return {
    text,
    room: currentRoom,
    askedOptions: activity.some(
      (item) => item.tool === "askOptions" || item.tool === "showSpecSummary",
    ),
  };
}

export const designRoom = internalAction({
  returns: v.object({
    text: v.string(),
    room: v.union(zodToConvex(roomSchema), v.null()),
  }),
  args: { roomId: v.id("rooms"), instruction: v.string() },
  handler: async (ctx, { roomId, instruction }) => {
    const { text, room } = await runAgent(ctx, roomId, instruction);
    return { text, room };
  },
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
      const stage: ProjectPhase = project.phase ?? "spec";
      const completed = messages.filter((message) => message.status === "done");
      let latestUserIndex = -1;
      for (let index = completed.length - 1; index >= 0; index--) {
        if (completed[index].role !== "user") continue;
        latestUserIndex = index;
        break;
      }
      const latestUser =
        latestUserIndex >= 0 ? completed[latestUserIndex].content : "";
      const previousAssistant = [...completed]
        .slice(0, latestUserIndex)
        .reverse()
        .find((message) => message.role === "assistant")?.content ?? "";
      const forcePlanSpace = shouldForcePlanSpace(
        stage,
        latestUser,
        previousAssistant,
      );
      const roomDoc = project.roomId
        ? await ctx.runQuery(internal.rooms.getRoom, { roomId: project.roomId })
        : null;
      const status =
        stage === "spec"
          ? `\n${specStatusLine(normalizeBrief(roomDoc?.brief ?? project.brief ?? emptyBrief()))}`
          : "";
      const { text, askedOptions } = await runAgent(
        ctx,
        project.roomId ?? null,
        `Current stage: ${stage}${project.roomId ? "" : " (no room attached yet)"}.${status}\n\nConversation so far:\n${transcript}\n\nRespond to the user's latest message.`,
        projectId,
        async (content, activity, recommendationProductId, recommendations) => {
          await ctx.runMutation(internal.messages.updateProgress, {
            messageId,
            content,
            activity,
            recommendationProductId,
            recommendations: recommendations ?? undefined,
          });
        },
        reply?.activity ?? undefined,
        reply?.selectedObjectId ?? null,
        forcePlanSpace,
      );
      // A choice written as a text list is not clickable. Turn it into the
      // card the model should have used.
      const card =
        askedOptions || text.includes(SPEC_SUMMARY_OPTIONS[0])
          ? null
          : choiceListToCard(text);
      if (card) {
        await complete(card.intro, "done");
        await ctx.runMutation(internal.messages.ask, {
          projectId,
          question: card.question,
          options: card.options,
          multiSelect: card.multiSelect,
        });
        return;
      }
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
