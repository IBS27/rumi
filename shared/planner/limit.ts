import type { ReservedZone, ZoneRejection } from "../contracts";
import { isRugCategory } from "./scope";

// Trim successful reservations, so pieces that cannot fit do not consume the
// item allowance. A requested accessory also protects its supporting furniture.
export function limitPlanItems(
  zones: ReservedZone[],
  maxItems: number,
  requiredIds: Set<string>,
): {
  zones: ReservedZone[];
  rejected: ZoneRejection[];
  requiredIds: Set<string>;
} {
  const protectedIds = new Set(requiredIds);
  const protectHost = (id: string) => {
    const zone = zones.find((item) => item.id === id);
    if (
      zone?.mount !== "surface" ||
      !zone.relatedObjectId ||
      protectedIds.has(zone.relatedObjectId)
    )
      return;
    protectedIds.add(zone.relatedObjectId);
    protectHost(zone.relatedObjectId);
  };
  for (const id of requiredIds) protectHost(id);
  // Keep reservation order (hosts before accessories) for product placement.
  const kept = [...zones];
  const rejected: ZoneRejection[] = [];
  while (
    kept.filter((zone) => !isRugCategory(zone.category)).length > maxItems
  ) {
    const victim = [...kept]
      .reverse()
      .sort((a, b) => b.priority - a.priority)
      .find(
        (zone) =>
          !isRugCategory(zone.category) &&
          !protectedIds.has(zone.id) &&
          !kept.some(
            (other) =>
              other.mount === "surface" && other.relatedObjectId === zone.id,
          ),
      );
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
    rejected.push({
      zoneId: victim.id,
      reason: `Left out ${victim.category} to keep the initial plan to ${maxItems} pieces, plus rugs. You can ask to add it later.`,
    });
  }
  return { zones: kept, rejected, requiredIds: protectedIds };
}
