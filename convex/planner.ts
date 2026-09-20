import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { v } from "convex/values";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { normalizeBrief } from "./projects";
import {
  designPlanSchema,
  zonePlanRequestSchema,
  zonePlanWireSchema,
  type DesignBrief,
  type DesignPlan,
  type ProductCandidate,
  type RoomSnapshot,
} from "../shared/contracts";
import {
  MAX_SUGGESTIONS,
  buildDesignPlan,
  buildSpaceModel,
} from "../shared/planner";
import { freeArea, type SpaceModel } from "../shared/planner/space";

// The model decides what the room needs and why. Every meter, margin, and price
// ceiling is computed in shared/planner so the plan cannot invent space.

function describeSpace(room: RoomSnapshot, model: SpaceModel): string {
  const furniture = model.obstacles.length
    ? model.obstacles
        .map((obstacle) => {
          const xs = obstacle.footprint.map((point) => point.x);
          const zs = obstacle.footprint.map((point) => point.z);
          return `- ${obstacle.name} (${obstacle.category}, id ${obstacle.id}${obstacle.locked ? ", locked" : ""}): footprint x ${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)} m, z ${Math.min(...zs).toFixed(2)}–${Math.max(...zs).toFixed(2)} m, top at ${obstacle.top.toFixed(2)} m`;
        })
        .join("\n")
    : "- none";
  const openings = model.walls
    .flatMap((wall) =>
      wall.openings.map(
        (opening) =>
          `- ${opening.kind} on wall ${wall.id} from (${opening.start.x.toFixed(2)}, ${opening.start.z.toFixed(2)}) to (${opening.end.x.toFixed(2)}, ${opening.end.z.toFixed(2)})`,
      ),
    )
    .join("\n");
  return [
    `Room "${room.name}" (${room.shape}, measurements ${room.measurementSource}).`,
    `Bounds: ${room.dimensions.width.toFixed(2)} m wide (X) × ${room.dimensions.depth.toFixed(2)} m deep (Z) × ${room.dimensions.height.toFixed(2)} m high (Y). Origin is the floor corner at (0, 0); X runs across, Z runs into the room.`,
    `Floor area ${model.floor.reduce((sum, ring) => sum + ring.length, 0) ? freeArea(model).toFixed(2) : "unknown"} m² is free after existing furniture, walking gaps, and door clearance.`,
    "Existing furniture:",
    furniture,
    openings ? `Openings:\n${openings}` : "Openings: none recorded.",
    model.warnings.length ? `Warnings: ${model.warnings.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function proposeZones(
  room: RoomSnapshot,
  brief: DesignBrief,
  products: ProductCandidate[],
  instruction: string,
  correction = "",
): Promise<{ plan: DesignPlan; model: SpaceModel }> {
  const model = buildSpaceModel(room);
  const occupied = room.objects
    .filter((object) => object.owned || object.locked)
    .map((object) => object.category);
  const { object } = await generateObject({
    model: openai(process.env.RUMI_PLANNER_MODEL ?? process.env.RUMI_AGENT_MODEL ?? "gpt-4o"),
    schema: zonePlanWireSchema,
    // Strict mode makes the provider enforce the schema so a stray string or
    // missing field is not returned as an unusable object.
    providerOptions: { openai: { strictJsonSchema: true } },
    abortSignal: AbortSignal.timeout(60000),
    experimental_repairText: async ({ text, error }) => {
      console.warn("planner output did not match schema", {
        error: error instanceof Error ? error.message : String(error),
        text: text.slice(0, 2000),
      });
      return null;
    },
    system: [
      "You are the space planner for rumi, an interior design agent.",
      "Propose up to 6 zones. Each zone is one piece of furniture the room still needs. category is a product type such as \"floor lamp\", \"wardrobe\", or \"area rug\", never a room or area name. query is a short shopping phrase for that product. Give the purpose, an anchor (wall, corner, center, window, near-object, anywhere), a realistic desired footprint in meters, and an optional height.",
      "Include accessories when they suit the brief: wall art, mirrors, rugs, table or desk lamps, plants, and similar pieces that take little floor space.",
      "mount says where a piece lives: floor (stands on the floor), wall (hung: art, mirror, wall shelf), surface (sits on top of a table, desk, dresser, or nightstand; relatedObjectId must name that host, either an existing object id or another zone id in this plan), under (a rug that lies under other furniture). Floor space is counted only for floor pieces.",
      "For wall pieces, desiredFootprint.width is the width along the wall and desiredHeight is the hanging height. For surface pieces, desiredFootprint is the base that rests on the host.",
      "Never output coordinates. Code reserves the exact position, applies clearance margins, and rejects zones that do not fit.",
      "One zone per category. Do not plan a category the room already has as owned or locked furniture.",
      "Use relatedObjectId with the exact id of an existing object when a zone belongs beside it, for example a lamp beside a bed.",
      "Priority 1 is the piece that defines the room. Accents come last.",
      "Put the user's material, feature, or usage requirements into miscellaneous as short phrases.",
    ].join("\n"),
    prompt: [
      describeSpace(room, model),
      `Categories already covered: ${occupied.length ? occupied.join(", ") : "none"}.`,
      `Brief: ${brief.prompt || "(none)"}. Styles: ${brief.styles.join(", ") || "(none)"}. Palette: ${brief.palette.join(", ") || "(none)"}. Materials: ${brief.materials.join(", ") || "(none)"}. Restrictions: ${brief.restrictions.join(", ") || "(none)"}. Budget: ${brief.budgetCents > 0 ? `$${(brief.budgetCents / 100).toFixed(0)}` : "not specified"}.`,
      brief.inspiration ? `Inspiration: ${brief.inspiration}` : "",
      brief.wants.length
        ? `Items the user asked for (each MUST get its own zone, category matching): ${brief.wants
            .map((want) => `${want.category}${want.notes ? ` (${want.notes})` : ""}`)
            .join("; ")}. You may add at most ${MAX_SUGGESTIONS} extra accessories that suit the style.`
        : "The user has not listed items; propose what the room needs.",
      `Instruction: ${instruction}`,
      correction ? `Your previous plan was rejected: ${correction} Fix this.` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const request = zonePlanRequestSchema.safeParse(object);
  if (!request.success)
    throw new Error(
      `The planner returned an unusable plan: ${request.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  try {
    return buildDesignPlan({ room, brief, products, request: request.data });
  } catch (error) {
    // One correction pass: the rules are stated in the rejection, so the model
    // can repair a plan that overreached or left out a want.
    if (correction || !(error instanceof Error)) throw error;
    return proposeZones(room, brief, products, instruction, error.message);
  }
}

export const planRoom = internalAction({
  returns: zodToConvex(designPlanSchema),
  args: { roomId: v.id("rooms"), instruction: v.string() },
  handler: async (ctx, { roomId, instruction }): Promise<DesignPlan> => {
    const doc = await ctx.runQuery(internal.rooms.getRoom, { roomId });
    if (!doc) throw new Error("This room does not exist.");
    const ids = doc.snapshot.objects
      .map((object) => object.productId)
      .filter((id): id is string => id !== null);
    const products = await ctx.runQuery(internal.products.getByIds, { ids });
    const { plan } = await proposeZones(
      doc.snapshot,
      normalizeBrief(doc.brief),
      products,
      instruction,
    );
    return plan;
  },
});
