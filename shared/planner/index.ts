import {
  designPlanSchema,
  searchTaskSchema,
  zonePlanRequestSchema,
  type DesignBrief,
  type DesignPlan,
  type ProductCandidate,
  type RoomObject,
  type ReservedZone,
  type RoomSnapshot,
  type SearchTask,
  type ZoneFill,
  type ZonePlanRequest,
} from "../contracts";
import { selectionTotal } from "../budget";
import { colorFromWords } from "../search/color";
import { buildSpaceModel, type SpaceModel } from "./space";
import { splitBudget } from "./budget";
import { limitPlanItems } from "./limit";
import {
  categoryIsExcluded,
  requiredDefiningPiece,
  isAccessoryMount,
  matchesDefiningPiece,
  planScope,
  sameCategory,
} from "./scope";
import { mountFor, reserveZones } from "./zones";

export { buildSpaceModel } from "./space";
export { describeFreeFloorAreas, findFreeFloorAreas } from "./free-floor";
export { marginsFor, mountFor, reserveZones, scaleMargins } from "./zones";
export {
  MAX_ZONES,
  SPACING_FACTOR,
  definingPieceForPurpose,
  requiredDefiningPiece,
  describeScope,
  matchesDefiningPiece,
  planScope,
} from "./scope";
export { ceilingFloorCents, splitBudget, typicalPriceCents } from "./budget";

const RESTRICTION_TAGS: [RegExp, string[]][] = [
  [/no drill|no drilling|no holes|renter|rental/i, ["wall-mounted", "drilling required"]],
  [/no glass|avoid glass/i, ["glass"]],
  [/pet|dog|cat/i, ["delicate fabric"]],
  [/no assembly|assembled/i, ["assembly required"]],
];

export function excludeTagsFor(brief: DesignBrief): string[] {
  const tags = new Set<string>();
  for (const restriction of brief.restrictions)
    for (const [pattern, values] of RESTRICTION_TAGS)
      if (pattern.test(restriction)) values.forEach((value) => tags.add(value));
  return [...tags];
}

export function remainingBudgetCents(
  room: RoomSnapshot | null,
  brief: DesignBrief,
  products: ProductCandidate[],
): number | null {
  // null means unspecified; zero means a specified budget is exhausted.
  if (brief.budgetCents <= 0) return null;
  if (!room) return brief.budgetCents;
  return Math.max(0, brief.budgetCents - selectionTotal(room, products));
}

// Budget is split in proportion to what each category typically costs, so no
// zone gets a ceiling the market cannot meet. Only an unspecified budget
// becomes an unlimited search ceiling. See ./budget for the rules.
export function allocateBudget(
  zones: ReservedZone[],
  remainingCents: number | null,
): Map<string, number> {
  return splitBudget(zones, remainingCents).allocation;
}

export function zoneToSearchTask(
  zone: ReservedZone,
  brief: DesignBrief,
  maxPriceCents: number,
): SearchTask {
  // Merchants list hung pieces as width × height, and the pipeline compares
  // the listing's depth against the ceiling's depth. For a wall piece, let the
  // "depth" ceiling carry the wall height so a W × H listing passes, and let
  // maxHeight also carry the wall height in case the listing is W × H × D.
  const wall = zone.mount === "wall";
  return searchTaskSchema.parse({
    query: zone.query,
    category: zone.category,
    maxPriceCents,
    maxFootprint: wall
      ? { width: zone.footprint.width, depth: zone.maxHeight ?? zone.footprint.width }
      : zone.footprint,
    maxHeight: zone.maxHeight,
    styleTerms: brief.styles,
    // Color words become hex for ranking; the words themselves go to search.
    palette: [
      ...new Set(
        brief.palette
          .map((word) => colorFromWords(word)?.hex)
          .filter((hex): hex is string => Boolean(hex)),
      ),
    ],
    miscellaneous: [
      ...new Set([
        zone.purpose,
        ...zone.miscellaneous,
        ...brief.palette,
        ...brief.wants
          .filter((want) => want.notes && sameCategory(want.category, zone.category))
          .map((want) => want.notes),
        ...brief.materials,
      ]),
    ].slice(0, 12),
    excludeTags: excludeTagsFor(brief),
  });
}

export interface PlanInput {
  room: RoomSnapshot;
  brief: DesignBrief;
  products: ProductCandidate[];
  request: unknown;
  placementHints?: RoomObject[];
}

export function buildDesignPlan({
  room,
  brief,
  products,
  request,
  placementHints = [],
}: PlanInput): { plan: DesignPlan; model: SpaceModel } {
  const parsed: ZonePlanRequest = zonePlanRequestSchema.parse(request);
  const requestsById = new Map(parsed.zones.map((zone) => [zone.id, zone]));
  if (requestsById.size !== parsed.zones.length)
    throw new Error("Zone ids must be unique.");
  const categories = parsed.zones.map((zone) => zone.category.toLowerCase());
  if (new Set(categories).size !== categories.length)
    throw new Error("Plan one zone per category.");
  const occupied = room.objects
    .filter((object) => object.owned || object.locked)
    .map((object) => object.category.toLowerCase());
  const scope = planScope(brief);
  const excludedZone = parsed.zones.find((zone) => categoryIsExcluded(zone.category, scope.excluded));
  if (excludedZone)
    throw new Error(`The user excluded ${excludedZone.category}. Remove it and plan only the remaining allowed furniture; do not ask to add it back.`);
  const definingPiece = requiredDefiningPiece(brief);
  const definingPiecePresent =
    definingPiece !== null &&
    room.objects.some((object) =>
      matchesDefiningPiece(definingPiece, object.category),
    );
  const definingRequest =
    definingPiece && !definingPiecePresent
      ? parsed.zones.find((zone) =>
          matchesDefiningPiece(definingPiece, zone.category),
        )
      : null;
  if (definingPiece && !definingPiecePresent && !definingRequest)
    throw new Error(
      `The ${brief.purpose || "room"} is missing its defining ${definingPiece.category}. Add it as the priority-1 zone before secondary furniture.`,
    );
  if (
    definingRequest &&
    definingRequest.priority !==
      Math.min(...parsed.zones.map((zone) => zone.priority))
  )
    throw new Error(
      `The defining ${definingPiece?.category} must be reserved before secondary furniture. Make it the priority-1 zone.`,
    );
  const duplicate = parsed.zones.find((zone) =>
    occupied.includes(zone.category.toLowerCase()) &&
    !scope.required.some((category) => sameCategory(category, zone.category)),
  );
  if (duplicate)
    throw new Error(
      `The room already has a ${duplicate.category}; plan around it instead of adding another.`,
    );
  // The scope says what the model may add. Every required item needs a zone.
  // In directed mode, extra floor furniture is capped; accessories follow the
  // user's answer. The default total is applied after geometry checks.
  const missing = scope.required.filter(
    (category) =>
      !parsed.zones.some((zone) => sameCategory(zone.category, category)),
  );
  if (missing.length)
    throw new Error(
      `The plan leaves out items the user asked for: ${missing.join(", ")}. Add a zone for each.`,
    );
  const isSuggested = (category: string) =>
    scope.mode === "directed" &&
    !scope.required.some((required) => sameCategory(required, category));
  const extraFurniture = parsed.zones.filter(
    (zone) => isSuggested(zone.category) && !isAccessoryMount(mountFor(zone)),
  );
  if (extraFurniture.length > scope.maxExtraFurniture)
    throw new Error(
      `Only ${scope.maxExtraFurniture} extra floor piece is allowed beyond the user's items; drop ${extraFurniture.map((zone) => zone.category).join(", ")} down to ${scope.maxExtraFurniture}.`,
    );
  const accessories = parsed.zones.filter(
    (zone) => isAccessoryMount(mountFor(zone)) && isSuggested(zone.category) === (scope.mode === "directed"),
  );
  if (scope.accessories === "skip" && accessories.length)
    throw new Error(
      `The user does not want accessories; drop ${accessories.map((zone) => zone.category).join(", ")}.`,
    );
  const model = buildSpaceModel(room);
  const reserved = reserveZones(
    room,
    model,
    parsed.zones,
    parsed.spacing,
    room.dimensions.height,
    placementHints,
  );
  if (
    definingRequest &&
    reserved.rejected.some((item) => item.zoneId === definingRequest.id)
  )
    throw new Error(
      `The defining ${definingPiece?.category} could not be reserved. Keep it first and retry with a smaller standard footprint or a better anchor instead of returning a plan made only of secondary pieces.`,
    );
  const protectedIds = new Set(parsed.zones
    .filter((zone) => zone.id === definingRequest?.id || scope.required.some((category) => sameCategory(category, zone.category)))
    .map((zone) => zone.id));
  const limited = limitPlanItems(reserved.zones.map((zone) => ({
    ...zone, priority: requestsById.get(zone.id)?.priority ?? zone.priority,
  })), scope.maxZones, protectedIds);
  const flagged = limited.zones.map((zone) => {
    // Resizing a requested bed must not turn it into a budget-droppable extra
    // or lose the user's feature requirements when its category changes.
    const category = requestsById.get(zone.id)?.category ?? zone.category;
    return {
      ...zone,
      suggested: isSuggested(category) && !limited.requiredIds.has(zone.id),
      miscellaneous: [...new Set([
        ...zone.miscellaneous,
        ...brief.wants.filter((want) => want.notes && sameCategory(want.category, category))
          .map((want) => want.notes),
      ])].slice(0, 12),
    };
  });
  // A zone the budget cannot give a workable ceiling is dropped like one that
  // did not fit, with the reason on the card, rather than searched in vain.
  const split = splitBudget(flagged, remainingBudgetCents(room, brief, products));
  const zones = flagged
    .filter((zone) => split.allocation.has(zone.id))
    .map((zone, index) => ({ ...zone, priority: index + 1 }));
  const rejected = [...reserved.rejected, ...limited.rejected, ...split.dropped];
  const tasks = zones.map((zone) =>
    zoneToSearchTask(zone, brief, split.allocation.get(zone.id) ?? 0),
  );
  const plan = designPlanSchema.parse({
    roomId: room.id,
    baseRevision: room.revision,
    summary: parsed.summary,
    spacing: parsed.spacing,
    zones,
    rejected,
    tasks,
  });
  return { plan, model };
}

export function evaluateFill(
  zone: ReservedZone,
  product: ProductCandidate | null,
): ZoneFill {
  if (!product)
    return { zoneId: zone.id, productId: null, fits: "no", issues: ["No product found."] };
  const dimensions = product.measurement.dimensions;
  if (!dimensions)
    return {
      zoneId: zone.id,
      productId: product.id,
      fits: "unknown",
      issues: ["The merchant page did not state dimensions."],
    };
  const issues: string[] = [];
  // A hung piece uses the wall: its width runs along the wall, its height up
  // the wall, and only its thickness comes into the room.
  const fitsFootprint =
    zone.mount === "wall"
      ? dimensions.width <= zone.footprint.width + 1e-6 ||
        dimensions.height <= zone.footprint.width + 1e-6
      : (dimensions.width <= zone.footprint.width + 1e-6 &&
          dimensions.depth <= zone.footprint.depth + 1e-6) ||
        (dimensions.width <= zone.footprint.depth + 1e-6 &&
          dimensions.depth <= zone.footprint.width + 1e-6);
  if (!fitsFootprint)
    issues.push(
      zone.mount === "wall"
        ? `Width ${dimensions.width} m exceeds the reserved ${zone.footprint.width} m of wall.`
        : `Footprint ${dimensions.width} × ${dimensions.depth} m exceeds the reserved ${zone.footprint.width} × ${zone.footprint.depth} m.`,
    );
  const vertical =
    zone.mount === "wall"
      ? Math.min(dimensions.height, dimensions.depth)
      : dimensions.height;
  if (zone.maxHeight !== null && vertical > zone.maxHeight)
    issues.push(`Height ${vertical} m exceeds ${zone.maxHeight} m.`);
  if (product.measurement.source === "estimated")
    issues.push("Dimensions are estimated from the merchant page.");
  return {
    zoneId: zone.id,
    productId: product.id,
    fits: issues.some((issue) => issue.includes("exceeds")) ? "no" : "yes",
    issues,
  };
}
