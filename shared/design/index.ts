import {
  roomObjectSchema,
  roomSchema,
  type DesignBrief,
  type ProductCandidate,
  type RoomObject,
  type RoomSnapshot,
} from "../contracts";
import { selectionTotal } from "../budget";
import { designCommandsSchema, type DesignCommand } from "./contracts";
import {
  autoPlaceProduct,
  designPlacementIssue,
  objectInZone,
  productObject,
  prefersSurface,
} from "./placement";

export {
  designCommandSchema,
  designCommandsSchema,
  type DesignCommand,
} from "./contracts";
export {
  designPlacementIssue,
  objectInZone,
  productObject,
  suggestPlacement,
} from "./placement";

const spatialChange = (a: RoomObject, b: RoomObject) =>
  (["position", "rotation", "dimensions"] as const).some((key) =>
    Object.entries(a[key]).some(
      ([axis, value]) =>
        Math.abs(value - (b[key] as Record<string, number>)[axis]) > 0.000001,
    ),
  );

/** No writes escape this function until the complete resulting design is valid. */
export function applyDesignCommands(
  room: RoomSnapshot,
  input: DesignCommand[],
  products: ProductCandidate[],
  brief: DesignBrief,
  actor: "user" | "agent" = "user",
): RoomSnapshot {
  const commands = designCommandsSchema.parse(input);
  let next = structuredClone(room);
  const changed = new Set<string>();
  const getProduct = (id: string) => {
    const product = products.find((item) => item.id === id);
    if (!product)
      throw new Error(
        "This product is no longer in the catalog. Search again.",
      );
    return product;
  };
  for (const command of commands) {
    if (command.type === "discover") {
      if (
        actor !== "user" ||
        !command.object.owned ||
        command.object.productId ||
        command.object.detectionSource !== "photo"
      )
        throw new Error("Only captured possessions can be imported this way.");
      if (!next.objects.some((item) => item.id === command.object.id))
        next.objects.push(command.object);
      continue;
    }
    if (command.type === "add") {
      if (next.objects.some((item) => item.id === command.instanceId))
        throw new Error("This item is already in your room.");
      if (
        command.zone &&
        next.objects.some((item) => item.zoneId === command.zone!.id)
      )
        throw new Error(
          "This planned spot already has a product. Replace that item instead.",
        );
      const product = getProduct(command.productId);
      let object = command.zone
        ? objectInZone(next, product, command.instanceId, command.zone)
        : productObject(product, command.instanceId);
      if (command.position) object.position = command.position;
      if (command.rotationY !== undefined)
        object.rotation.y = command.rotationY;
      if (
        !command.position &&
        (!command.zone ||
          (command.zone.mount === "floor" && prefersSurface(product)))
      ) {
        const placement = autoPlaceProduct(
          next,
          product,
          object.id,
          command.nearObjectId,
        );
        if (!placement)
          throw new Error(
            "No suitable clear placement was found. Try another surface or a smaller product.",
          );
        object = placement;
        if (command.zone) object.zoneId = command.zone.id;
      }
      next.objects.push(object);
      changed.add(object.id);
      continue;
    }
    const id =
      command.type === "correct" ? command.object.id : command.objectId;
    const object = next.objects.find((item) => item.id === id);
    if (!object) throw new Error("This item was removed. Select another item.");
    if (command.type === "arrange") {
      if (object.locked) throw new Error(`${object.name} is locked in place.`);
      if (!object.productId)
        throw new Error("Automatic arrangement requires a catalog product.");
      if (next.objects.some((item) => item.supportId === id))
        throw new Error(
          "Move the items on this piece before arranging it automatically.",
        );
      const placement = autoPlaceProduct(
        { ...next, objects: next.objects.filter((item) => item.id !== id) },
        getProduct(object.productId),
        id,
        command.nearObjectId,
      );
      if (!placement)
        throw new Error(
          "No suitable clear placement was found. Try another surface or a smaller product.",
        );
      next.objects = next.objects.map((item) =>
        item.id === id
          ? {
              ...placement,
              productLocked: object.productLocked,
              locked: object.locked,
              zoneId: object.zoneId,
            }
          : item,
      );
      changed.add(id);
      continue;
    }
    if (command.type === "lock") {
      if (
        actor === "agent" &&
        ((object.locked && !command.placementLocked) ||
          (object.productLocked && !command.productLocked))
      )
        throw new Error(
          "Only the user can unlock a kept product or placement.",
        );
      object.locked = command.placementLocked;
      object.productLocked = command.productLocked;
      continue;
    }
    if (command.type === "remove" || command.type === "replace") {
      if (object.productLocked)
        throw new Error(
          `${object.name} is kept. Unlock the product before removing or replacing it.`,
        );
      if (object.locked && command.type === "remove")
        throw new Error(
          `${object.name} is locked in place. Unlock it before removing it.`,
        );
      if (next.objects.some((item) => item.supportId === id))
        throw new Error(`Move or remove the items on ${object.name} first.`);
      if (command.type === "remove") {
        next.objects = next.objects.filter((item) => item.id !== id);
        changed.delete(id);
      } else {
        const replacement = {
          ...productObject(getProduct(command.productId), id),
          position: object.position,
          rotation: object.rotation,
          mount: object.mount,
          supportId: object.supportId,
          zoneId: object.zoneId,
          locked: object.locked,
        };
        next.objects = next.objects.map((item) =>
          item.id === id ? replacement : item,
        );
        changed.add(id);
      }
      continue;
    }
    if (command.type === "correct") {
      if (actor !== "user")
        throw new Error("Scan corrections require the room inspector.");
      const corrected = roomObjectSchema.parse(command.object);
      if (
        corrected.productId !== object.productId ||
        corrected.owned !== object.owned ||
        corrected.assetId !== object.assetId ||
        corrected.supportId !== object.supportId ||
        corrected.mount !== object.mount
      )
        throw new Error(
          "Use product replacement to change the selected variant.",
        );
      if (
        object.productId &&
        ((["width", "height", "depth"] as const).some(
          (axis) => corrected.dimensions[axis] !== object.dimensions[axis],
        ) ||
          corrected.color !== object.color ||
          corrected.category !== object.category)
      )
        throw new Error(
          "A catalog product keeps its actual dimensions and appearance. Choose another variant to change them.",
        );
      if (object.locked && spatialChange(object, corrected))
        throw new Error("Unlock this placement before moving or resizing it.");
      if (spatialChange(object, corrected)) {
        if (next.objects.some((item) => item.supportId === id))
          throw new Error(
            "Use the move controls to move furniture with items on it. Remove those items before resizing the support.",
          );
        changed.add(id);
      }
      next.objects = next.objects.map((item) =>
        item.id === id ? corrected : item,
      );
    } else {
      if (object.locked) throw new Error(`${object.name} is locked in place.`);
      const before = structuredClone(object);
      object.position = command.position;
      object.rotation.y = command.rotationY;
      // Supported accessories travel with their host, preserving their local offset.
      const turn = object.rotation.y - before.rotation.y;
      for (const child of next.objects.filter(
        (item) => item.supportId === object.id,
      )) {
        if (child.locked)
          throw new Error(
            `${child.name} is locked on this piece. Unlock it before moving the support.`,
          );
        const dx = child.position.x - before.position.x,
          dz = child.position.z - before.position.z;
        child.position = {
          x: object.position.x + dx * Math.cos(turn) + dz * Math.sin(turn),
          y: child.position.y + object.position.y - before.position.y,
          z: object.position.z - dx * Math.sin(turn) + dz * Math.cos(turn),
        };
        child.rotation.y += turn;
        changed.add(child.id);
      }
      changed.add(id);
    }
  }
  for (const id of changed) {
    const object = next.objects.find((item) => item.id === id)!;
    const issue = designPlacementIssue(next, object);
    if (issue) throw new Error(`${object.name}: ${issue}`);
  }
  const total = selectionTotal(next, products);
  // Removing or moving items remains possible when the user lowered the budget.
  const before = selectionTotal(room, products);
  if (brief.budgetCents > 0 && total > brief.budgetCents && total > before)
    throw new Error(
      `This change is $${((total - brief.budgetCents) / 100).toFixed(2)} over your budget. Remove or replace an item first.`,
    );
  next = roomSchema.parse({ ...next, revision: room.revision + 1 });
  return next;
}

export function commandProductIds(
  room: RoomSnapshot,
  commands: DesignCommand[],
) {
  return [
    ...new Set([
      ...room.objects.flatMap((item) =>
        item.productId ? [item.productId] : [],
      ),
      ...commands.flatMap((command) =>
        command.type === "add" || command.type === "replace"
          ? [command.productId]
          : [],
      ),
    ]),
  ];
}
