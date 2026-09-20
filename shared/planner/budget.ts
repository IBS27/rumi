import type { ReservedZone, ZoneRejection } from "../contracts";

// What a category plausibly costs at the retailers we search, in cents. Used
// to split a budget so no zone gets a ceiling nothing on the market can meet.
// These are weights and floors, not price predictions.
const TYPICAL_CENTS: [RegExp, number][] = [
  [/sectional/, 120000],
  [/sofa|couch|loveseat/, 80000],
  [/\bbed\b|bed frame|platform bed/, 60000],
  [/mattress/, 50000],
  [/wardrobe|armoire/, 45000],
  [/dresser|chest of drawers|sideboard|credenza|media console/, 35000],
  [/dining table/, 40000],
  [/desk/, 25000],
  [/coffee table|console table/, 18000],
  [/bookcase|bookshelf|shelving/, 18000],
  [/accent chair|armchair|lounge chair|reading chair/, 25000],
  [/office chair|desk chair/, 18000],
  [/dining chair/, 12000],
  [/nightstand|bedside table|side table|end table/, 12000],
  [/bench|ottoman|stool/, 12000],
  [/area rug|\brug\b|carpet|runner/, 15000],
  [/floor lamp|arc lamp/, 9000],
  [/pendant|chandelier|ceiling light/, 12000],
  [/table lamp|desk lamp|bedside lamp|sconce/, 5000],
  [/full[- ]length mirror|floor mirror|leaner mirror/, 12000],
  [/mirror/, 8000],
  [/wall art|artwork|painting|poster|print|canvas/, 6000],
  [/curtain|drape/, 6000],
  [/plant|planter/, 4000],
  [/throw|pillow|cushion|blanket/, 3000],
  [/vase|tray|candle|sculpture|bookend|decor/, 3000],
];
const DEFAULT_TYPICAL = 10000;
// Below this share of the typical price, a ceiling filters out the whole market.
const FLOOR_SHARE = 0.6;

export function typicalPriceCents(category: string): number {
  const value = category.toLowerCase();
  return TYPICAL_CENTS.find(([pattern]) => pattern.test(value))?.[1] ?? DEFAULT_TYPICAL;
}

export function ceilingFloorCents(category: string): number {
  return Math.round(typicalPriceCents(category) * FLOOR_SHARE);
}

export interface BudgetSplit {
  // Zones that keep a searchable ceiling (or 0 when the budget is unspecified).
  allocation: Map<string, number>;
  // Zones dropped because the budget could not give them a workable ceiling.
  dropped: ZoneRejection[];
}

// Split the remaining budget across zones in proportion to what each category
// typically costs. If the total cannot give every zone at least its floor,
// drop zones the user did not ask for, accessories first, then lowest
// priority, until the rest fit. Required zones are never dropped; if even they
// cannot be covered, the caller gets an error to relay.
export function splitBudget(
  zones: ReservedZone[],
  remainingCents: number | null,
): BudgetSplit {
  const allocation = new Map<string, number>();
  if (remainingCents === null || zones.length === 0) {
    zones.forEach((zone) => allocation.set(zone.id, 0));
    return { allocation, dropped: [] };
  }
  const kept = [...zones];
  const dropped: ZoneRejection[] = [];
  const floorTotal = () =>
    kept.reduce((sum, zone) => sum + ceilingFloorCents(zone.category), 0);
  // Drop order: suggested accessories, then suggested furniture, then by
  // lowest priority among suggestions. Required (non-suggested) zones stay.
  const dropOrder = (zone: ReservedZone) =>
    (zone.suggested ? 0 : 1000) + (zone.mount !== "floor" ? 0 : 100) + (100 - zone.priority);
  while (kept.length && floorTotal() > remainingCents) {
    const candidates = kept.filter((zone) => zone.suggested);
    if (!candidates.length) break;
    const victim = candidates.sort((a, b) => dropOrder(a) - dropOrder(b))[0];
    kept.splice(kept.indexOf(victim), 1);
    dropped.push({
      zoneId: victim.id,
      reason: `Dropped ${victim.category} for budget: a workable ceiling needs about $${(ceilingFloorCents(victim.category) / 100).toFixed(0)} and the remaining budget is spread too thin.`,
    });
  }
  if (floorTotal() > remainingCents)
    throw new Error(
      `The budget of $${(remainingCents / 100).toFixed(0)} cannot cover the requested items at realistic prices (about $${(floorTotal() / 100).toFixed(0)} needed). Raise the budget or remove an item.`,
    );
  const weightTotal = kept.reduce((sum, zone) => sum + typicalPriceCents(zone.category), 0);
  let assigned = 0;
  kept.forEach((zone, index) => {
    const share = Math.floor((remainingCents * typicalPriceCents(zone.category)) / weightTotal);
    // The last zone takes the rounding remainder so the ceilings sum to the budget.
    const cents = index === kept.length - 1 ? remainingCents - assigned : share;
    assigned += cents;
    allocation.set(zone.id, Math.max(1, cents));
  });
  return { allocation, dropped };
}
