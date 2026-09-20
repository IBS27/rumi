import {
  designPlanSchema,
  searchTaskSchema,
  zonePlanRequestSchema,
  type DesignBrief,
  type DesignPlan,
  type ProductCandidate,
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
import { isAccessoryMount, planScope, sameCategory } from "./scope";
import { mountFor, reserveZones } from "./zones";

export { buildSpaceModel } from "./space";
export { marginsFor, mountFor, reserveZones, scaleMargins } from "./zones";
export { MAX_ZONES, SPACING_FACTOR, describeScope, planScope } from "./scope";
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
}

export function buildDesignPlan({
  room,
  brief,
  products,
  request,
}: PlanInput): { plan: DesignPlan; model: SpaceModel } {
  const parsed: ZonePlanRequest = zonePlanRequestSchema.parse(request);
  const ids = new Set(parsed.zones.map((zone) => zone.id));
  if (ids.size !== parsed.zones.length)
    throw new Error("Zone ids must be unique.");
  const categories = parsed.zones.map((zone) => zone.category.toLowerCase());
  if (new Set(categories).size !== categories.length)
    throw new Error("Plan one zone per category.");
  const occupied = room.objects
    .filter((object) => object.owned || object.locked)
    .map((object) => object.category.toLowerCase());
  const scope = planScope(brief);
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
  // user's answer. In delegated mode the count is the model's judgment.
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
  const reserved = reserveZones(room, model, parsed.zones, parsed.spacing);
  const flagged = reserved.zones.map((zone) => ({
    ...zone,
    suggested: isSuggested(zone.category),
  }));
  // A zone the budget cannot give a workable ceiling is dropped like one that
  // did not fit, with the reason on the card, rather than searched in vain.
  const split = splitBudget(flagged, remainingBudgetCents(room, brief, products));
  const zones = flagged
    .filter((zone) => split.allocation.has(zone.id))
    .map((zone, index) => ({ ...zone, priority: index + 1 }));
  const rejected = [...reserved.rejected, ...split.dropped];
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
