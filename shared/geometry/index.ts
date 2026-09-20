import {
  categorySchema,
  proposalSchema,
  roomSchema,
  type DesignBrief,
  type DesignProposal,
  type ProductCandidate,
  type RoomObject,
  type RoomSnapshot,
} from "../contracts";
import { selectionTotal } from "../budget";

// Conservative axis-aligned footprint of a yaw-rotated object.
function bounds(object: RoomObject) {
  const c = Math.abs(Math.cos(object.rotation.y)),
    s = Math.abs(Math.sin(object.rotation.y));
  const width = object.dimensions.width * c + object.dimensions.depth * s;
  const depth = object.dimensions.width * s + object.dimensions.depth * c;
  return {
    left: object.position.x - width / 2,
    right: object.position.x + width / 2,
    near: object.position.z - depth / 2,
    far: object.position.z + depth / 2,
  };
}
export function placementIssue(
  room: RoomSnapshot,
  object: RoomObject,
): string | null {
  if (room.shape !== "rectangle")
    return "Furniture fit checks for scanned polygon rooms are not available yet.";
  if (object.rotation.x !== 0 || object.rotation.z !== 0)
    return "Only floor-aligned objects are supported by this placement validator.";
  const a = bounds(object);
  if (
    a.left < 0 ||
    a.right > room.dimensions.width ||
    a.near < 0 ||
    a.far > room.dimensions.depth ||
    object.position.y < 0 ||
    object.position.y + object.dimensions.height > room.dimensions.height
  )
    return "This item extends outside the room.";
  for (const door of room.openings.filter((item) => item.kind === "door")) {
    const clearance = door.width;
    const across =
      door.wall === "north" || door.wall === "south"
        ? a.right > door.offset && a.left < door.offset + door.width
        : a.far > door.offset && a.near < door.offset + door.width;
    const nearDoor =
      door.wall === "south"
        ? a.far > room.dimensions.depth - clearance
        : door.wall === "north"
          ? a.near < clearance
          : door.wall === "west"
            ? a.left < clearance
            : a.right > room.dimensions.width - clearance;
    if (object.category !== "rug" && across && nearDoor)
      return "This placement blocks the doorway clearance.";
  }
  for (const other of room.objects) {
    if (
      other.id === object.id ||
      object.category === "rug" ||
      other.category === "rug"
    )
      continue;
    const b = bounds(other);
    const verticalOverlap =
      object.position.y < other.position.y + other.dimensions.height &&
      object.position.y + object.dimensions.height > other.position.y;
    if (
      verticalOverlap &&
      a.left < b.right - 0.01 &&
      a.right > b.left + 0.01 &&
      a.near < b.far - 0.01 &&
      a.far > b.near + 0.01
    )
      return `This placement overlaps ${other.name.toLowerCase()}.`;
  }
  return null;
}
export function applyProposal(
  room: RoomSnapshot,
  input: DesignProposal,
  products: ProductCandidate[],
  brief: DesignBrief,
): RoomSnapshot {
  const proposal = proposalSchema.parse(input);
  if (proposal.roomId !== room.id || proposal.baseRevision !== room.revision)
    throw new Error("The room changed. Create a new proposal.");
  let next = structuredClone(room);
  for (const object of proposal.additions) {
    if (object.owned || !object.productId)
      throw new Error("New recommendations must reference a catalog product.");
    const product = products.find((item) => item.id === object.productId);
    if (!product || product.availability !== "available")
      throw new Error("This product is not available.");
    const dimensions = product.measurement.dimensions;
    if (!dimensions)
      throw new Error("Confirm product dimensions before placement.");
    if (
      dimensions.width !== object.dimensions.width ||
      dimensions.height !== object.dimensions.height ||
      dimensions.depth !== object.dimensions.depth
    )
      throw new Error("Placement dimensions must match the product variant.");
    if (next.objects.some((item) => item.id === object.id))
      throw new Error("This object already exists.");
    const issue = placementIssue(next, object);
    if (issue) throw new Error(issue);
    next = { ...next, objects: [...next.objects, object] };
  }
  if (selectionTotal(next, products) > brief.budgetCents)
    throw new Error("This selection exceeds your budget.");
  return roomSchema.parse({ ...next, revision: room.revision + 1 });
}
export function findPlacement(
  room: RoomSnapshot,
  product: ProductCandidate,
): RoomObject | null {
  if (room.shape !== "rectangle") return null;
  const category = categorySchema.safeParse(product.category);
  if (!product.measurement.dimensions || !category.success) return null;
  const object: RoomObject = {
    id: `placed-${product.id}`,
    name: product.name,
    category: category.data,
    productId: product.id,
    assetId: product.assetId,
    dimensions: product.measurement.dimensions,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    color: product.color,
    owned: false,
    locked: false,
  };
  for (let z = 0.35; z < room.dimensions.depth; z += 0.25) {
    for (let x = 0.35; x < room.dimensions.width; x += 0.25) {
      const candidate = { ...object, position: { x, y: 0, z } };
      if (!placementIssue(room, candidate)) return candidate;
    }
  }
  return null;
}
