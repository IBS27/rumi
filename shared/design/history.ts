import type { RoomObject } from "../contracts";

/** Keep undo bounded well below Convex's document limit, including large scans. */
export function appendHistory(history: RoomObject[][], objects: RoomObject[]) {
  const snapshots = [...history.slice(-9), objects];
  while (
    snapshots.length &&
    new TextEncoder().encode(JSON.stringify(snapshots)).length > 250_000
  )
    snapshots.shift();
  return snapshots;
}
