import { MAX_PLAN_ZONES, type DesignBrief, type Spacing, type ZoneMount } from "../contracts";

// What the planner may put in a room, decided from the brief alone.
//
// Delegated: the user listed no items, so the planner chooses the furniture
// from the room's purpose, the style, and the free floor space. How many
// pieces starts with a small default; code checks fit and trims optional extras.
// Directed: the user listed items; each is required, and the planner may add
// one floor piece the room clearly needs.
export interface PlanScope {
  mode: "delegated" | "directed";
  required: string[];
  excluded: string[];
  maxExtraFurniture: number;
  accessories: DesignBrief["accessories"];
  maxZones: number;
}

export const MAX_ZONES = MAX_PLAN_ZONES;
export const DEFAULT_PLAN_ITEMS = 4;

export function isRugCategory(category: string): boolean {
  return /\b(?:rugs?|carpets?|runners?)\b/i.test(category);
}

export interface DefiningPiece {
  category: string;
  aliases: string[];
}

// Default anchor for delegated furnishing, subordinate to the user's scope.
export function definingPieceForPurpose(purpose: string): DefiningPiece | null {
  const value = purpose.toLowerCase();
  if (/bedroom|guest room|primary room|master room/.test(value))
    return { category: "bed", aliases: ["bed", "daybed", "murphy bed"] };
  if (/living room|family room|lounge/.test(value))
    return { category: "sofa", aliases: ["sofa", "couch", "sectional", "loveseat"] };
  if (/dining/.test(value))
    return { category: "dining table", aliases: ["dining table"] };
  if (/office|study/.test(value))
    return { category: "desk", aliases: ["desk", "workstation"] };
  if (/nursery/.test(value))
    return { category: "crib", aliases: ["crib", "cot"] };
  return null;
}

export function matchesDefiningPiece(piece: DefiningPiece, category: string): boolean {
  return piece.aliases.some((alias) => sameCategory(alias, category));
}

export function excludedCategoriesForBrief(brief: DesignBrief): string[] {
  const excluded = [...(brief.excludedCategories ?? [])];
  // Compatibility for existing conversations that stored "No bed" only as
  // a restriction. Match complete exclusion statements, not constraints such
  // as "no bed wider than 2 m" or "no bed bugs".
  const piece = definingPieceForPurpose(brief.purpose);
  if (piece && brief.restrictions.some((restriction) => {
    const value = restriction.toLowerCase().trim().replace(/[.!]+$/, "");
    return piece.aliases.some((alias) => new RegExp(
      `^(?:(?:i )?(?:do not|don't) (?:need|want|include)|no|without|exclude|skip) (?:a |an |the |any |new )?${alias}s?$`,
    ).test(value));
  })) excluded.push(piece.category);
  return [...new Set(excluded)];
}

export function categoryIsExcluded(category: string, excluded: string[]): boolean {
  // Apply default-piece aliases too (e.g. excluding bed excludes daybed).
  const pieces = ["bedroom", "living room", "dining room", "office", "nursery"]
    .map(definingPieceForPurpose).filter((piece): piece is DefiningPiece => piece !== null);
  return excluded.some((item) => sameCategory(item, category) || pieces.some(
    (piece) => matchesDefiningPiece(piece, item) && matchesDefiningPiece(piece, category),
  ));
}

export function requiredDefiningPiece(brief: DesignBrief): DefiningPiece | null {
  const piece = definingPieceForPurpose(brief.purpose);
  if (!piece || categoryIsExcluded(piece.category, excludedCategoriesForBrief(brief)))
    return null;
  // A specific shopping list is not a request to furnish the whole room.
  if (brief.wants.length && !brief.wants.some((want) => matchesDefiningPiece(piece, want.category)))
    return null;
  return piece;
}

export function planScope(brief: DesignBrief): PlanScope {
  const excluded = excludedCategoriesForBrief(brief);
  const required = brief.wants.map((want) => want.category)
    .filter((category) => !categoryIsExcluded(category, excluded));
  const delegated = brief.wants.length === 0;
  return {
    mode: delegated ? "delegated" : "directed",
    required,
    excluded,
    maxExtraFurniture: delegated ? MAX_ZONES : 1,
    accessories: brief.accessories,
    maxZones: Math.max(DEFAULT_PLAN_ITEMS, required.filter((category) => !isRugCategory(category)).length),
  };
}

export function isAccessoryMount(mount: ZoneMount): boolean {
  return mount !== "floor";
}

export function sameCategory(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/s\b/g, "").trim();
  const x = norm(a),
    y = norm(b);
  if (!x || !y) return false;
  // Shopping terms for wall art differ from the scan's broad "art" category.
  // Match words, not substrings ("art" must not match "cart").
  const artwork = /\b(?:art|artwork|painting|poster|print)\b/;
  if (artwork.test(x) && artwork.test(y)) return true;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

// The style's density becomes a clearance multiplier. Safety minimums (door
// swing, a walkable path) are never scaled; see scaleMargins.
export const SPACING_FACTOR: Record<Spacing, number> = {
  airy: 1.25,
  balanced: 1,
  cozy: 0.85,
};

export function describeScope(
  scope: PlanScope,
  purpose: string,
  missingDefiningPiece: DefiningPiece | null = null,
): string {
  const room = purpose ? `a ${purpose}` : "this room";
  const accessories =
    scope.accessories === "skip"
      ? "Do not add accessories: no art, rugs, table lamps, or plants."
      : scope.accessories === "include"
        ? "The user wants accessories. Include the wall, surface, and under-mounted pieces that finish the style: art or a mirror, a rug, a lamp or two."
        : "Add an accessory or two only where the style clearly calls for it.";
  const spacing =
    "Set spacing from the style: airy for minimalist, Scandinavian, or Japandi rooms that breathe; cozy for eclectic, maximalist, or boho rooms that layer pieces; balanced otherwise. Airy plans hold fewer, larger pieces with generous clearance; cozy plans hold more pieces closer together.";
  const defining = missingDefiningPiece
    ? `The room is missing its defining ${missingDefiningPiece.category}. It MUST be a priority-1 zone; reserve it before secondary furniture.`
    : "";
  const exclusions = scope.excluded.length
    ? `Do not plan or search these excluded furniture categories (including equivalents): ${scope.excluded.join(", ")}. User exclusions override room-purpose defaults; do not insist on an excluded anchor.`
    : "";
  const count = `Aim for at most ${scope.maxZones} pieces, excluding rugs. Keep all explicitly requested items and any furniture needed to support them, even if that exceeds the default. Include the room-defining piece when required; do not add floor furniture to an accessories-only request.`;
  if (scope.mode === "delegated")
    return [
      defining,
      exclusions,
      `The user has not listed items. Choose the non-excluded furniture ${room} needs for its purpose and style, sized to the free floor space. Start with the most useful allowed piece, then storage, surfaces, seating, comfort and light as needed. Existing furniture reduces what is needed. Clearances may share walkways, so pieces can sit closer than their clearances suggest.`,
      count,
      spacing,
      accessories,
    ].join(" ");
  return [
    defining,
    exclusions,
    count,
    `Items the user asked for, each of which MUST get its own zone with a matching category: ${scope.required.join(", ")}.`,
    scope.maxExtraFurniture > 0
      ? `You may add at most ${scope.maxExtraFurniture} extra floor piece that ${room} clearly needs.`
      : "Do not add extra floor furniture.",
    spacing,
    accessories,
  ].join(" ");
}
