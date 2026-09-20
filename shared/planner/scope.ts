import type { DesignBrief, Spacing, ZoneMount } from "../contracts";

// What the planner may put in a room, decided from the brief alone.
//
// Delegated: the user listed no items, so the planner chooses the furniture
// from the room's purpose, the style, and the free floor space. How many
// pieces is the model's judgment; code only checks that each one fits.
// Directed: the user listed items; each is required, and the planner may add
// one floor piece the room clearly needs.
export interface PlanScope {
  mode: "delegated" | "directed";
  required: string[];
  maxExtraFurniture: number;
  accessories: DesignBrief["accessories"];
  maxZones: number;
}

export const MAX_ZONES = 8;

export function planScope(brief: DesignBrief): PlanScope {
  const required = brief.wants.map((want) => want.category);
  const delegated = required.length === 0;
  return {
    mode: delegated ? "delegated" : "directed",
    required,
    maxExtraFurniture: delegated ? MAX_ZONES : 1,
    accessories: brief.accessories,
    maxZones: MAX_ZONES,
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

export function describeScope(scope: PlanScope, purpose: string): string {
  const room = purpose ? `a ${purpose}` : "this room";
  const accessories =
    scope.accessories === "skip"
      ? "Do not add accessories: no art, rugs, table lamps, or plants."
      : scope.accessories === "include"
        ? "The user wants accessories. Include the wall, surface, and under-mounted pieces that finish the style: art or a mirror, a rug, a lamp or two."
        : "Add an accessory or two only where the style clearly calls for it.";
  const spacing =
    "Set spacing from the style: airy for minimalist, Scandinavian, or Japandi rooms that breathe; cozy for eclectic, maximalist, or boho rooms that layer pieces; balanced otherwise. Airy plans hold fewer, larger pieces with generous clearance; cozy plans hold more pieces closer together.";
  if (scope.mode === "delegated")
    return [
      `The user has not listed items. Choose the furniture ${room} needs for its purpose and style, sized to the free floor space. Start with the piece that defines the room, then what makes it usable (storage, a surface, seating), then comfort and light. A furnished room usually has 4 to 6 floor pieces plus accessories; propose the full set the purpose calls for and let the code drop what does not fit, rather than leaving obvious needs out. Clearances may share walkways, so pieces can sit closer than their clearances suggest.`,
      spacing,
      accessories,
    ].join(" ");
  return [
    `Items the user asked for, each of which MUST get its own zone with a matching category: ${scope.required.join(", ")}.`,
    scope.maxExtraFurniture > 0
      ? `You may add at most ${scope.maxExtraFurniture} extra floor piece that ${room} clearly needs.`
      : "Do not add extra floor furniture.",
    spacing,
    accessories,
  ].join(" ");
}
