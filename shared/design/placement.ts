import polygonClipping from "polygon-clipping";
import { worldCorners } from "../capture/roomplan";
import type {
  ProductCandidate,
  ReservedZone,
  RoomObject,
  RoomSnapshot,
} from "../contracts";
import {
  buildSpaceModel,
  objectObstacle,
  rectangleRing,
  ringInside,
  type Ring,
  type SpaceModel,
} from "../planner/space";
import { reserveZones } from "../planner/zones";

const EPS = 0.005;
const polygon = (ring: Ring): [number, number][][] => [
  ring.map(({ x, z }) => [
    Math.round(x * 1e6) / 1e6,
    Math.round(z * 1e6) / 1e6,
  ]),
];
const area = (rings: number[][][]) =>
  rings.reduce(
    (total, ring, i) =>
      total +
      ((i ? -1 : 1) *
        Math.abs(
          ring.reduce((sum, p, j) => {
            const q = ring[(j + 1) % ring.length];
            return sum + p[0] * q[1] - q[0] * p[1];
          }, 0),
        )) /
        2,
    0,
  );
function overlap(a: Ring, b: Ring) {
  // Bodies are convex hulls; separating axes handle touching and rotated boxes
  // without feeding near-zero edges to a general polygon clipping operation.
  for (const ring of [a, b]) {
    for (let i = 0; i < ring.length; i++) {
      const start = ring[i],
        end = ring[(i + 1) % ring.length];
      const dx = end.x - start.x,
        dz = end.z - start.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-9) continue;
      const project = (p: { x: number; z: number }) =>
        (-dz * p.x + dx * p.z) / length;
      const pa = a.map(project),
        pb = b.map(project);
      if (
        Math.max(...pa) <= Math.min(...pb) + 1e-6 ||
        Math.max(...pb) <= Math.min(...pa) + 1e-6
      )
        return false;
    }
  }
  return true;
}
function insideFloor(room: RoomSnapshot, footprint: Ring, model: SpaceModel) {
  const floors =
    room.shape === "polygon"
      ? room.floors.map((floor) =>
          worldCorners(floor).map(({ x, z }) => ({ x, z })),
        )
      : model.floor;
  if (!floors.length) return false;
  // Difference against the union preserves concavities, adjoining patches and holes.
  try {
    return !polygonClipping
      .difference(polygon(footprint), ...floors.map(polygon))
      .some((p) => area(p) > 0.0001);
  } catch {
    return false;
  }
}

export function designPlacementIssue(
  room: RoomSnapshot,
  object: RoomObject,
  model = buildSpaceModel(room),
): string | null {
  const body = objectObstacle(object);
  if (
    body.bottom < model.floorY - EPS ||
    body.top > model.floorY + room.dimensions.height + EPS
  )
    return "This item extends below the floor or above the ceiling.";
  if (room.shape === "polygon" && !room.floors.length)
    return "This scan has no measured floor. Import a scan with a floor before placing furniture.";
  if (!insideFloor(room, body.footprint, model))
    return "This item extends outside the room's floor boundary.";

  if (object.mount === "surface") {
    const host = room.objects.find((item) => item.id === object.supportId);
    if (!host) return "Place the supporting table or cabinet first.";
    const support = objectObstacle(host);
    if (
      Math.abs(body.bottom - support.top) > EPS ||
      !ringInside(body.footprint, [support.footprint])
    )
      return `This item must sit fully on top of ${host.name}.`;
  } else if (
    object.mount !== "wall" &&
    !object.owned &&
    Math.abs(body.bottom - model.floorY) > 0.04
  ) {
    return "Floor furniture must stand on the floor.";
  }

  let wallContact = false;
  for (const wall of model.walls) {
    const dx = wall.end.x - wall.start.x,
      dz = wall.end.z - wall.start.z;
    const length = Math.hypot(dx, dz);
    if (!length) continue;
    const yaw = -Math.atan2(dz, dx);
    const strip = rectangleRing(
      {
        x: (wall.start.x + wall.end.x) / 2,
        z: (wall.start.z + wall.end.z) / 2,
      },
      length,
      0.008,
      yaw,
    );
    if (overlap(body.footprint, strip)) return "This placement crosses a wall.";
    if (object.mount === "wall") {
      const distance =
        Math.abs(
          (object.position.x - wall.start.x) * dz -
            (object.position.z - wall.start.z) * dx,
        ) / length;
      const along =
        ((object.position.x - wall.start.x) * dx +
          (object.position.z - wall.start.z) * dz) /
        length;
      const alignment = Math.abs(
        (Math.cos(object.rotation.y) * dx) / length -
          (Math.sin(object.rotation.y) * dz) / length,
      );
      if (
        distance <= object.dimensions.depth / 2 + 0.07 &&
        along >= object.dimensions.width / 2 - EPS &&
        along + object.dimensions.width / 2 <= length + EPS &&
        alignment > 0.99
      ) {
        wallContact = true;
        for (const opening of wall.openings) {
          const start =
            ((opening.start.x - wall.start.x) * dx +
              (opening.start.z - wall.start.z) * dz) /
            length;
          const end =
            ((opening.end.x - wall.start.x) * dx +
              (opening.end.z - wall.start.z) * dz) /
            length;
          if (
            along + object.dimensions.width / 2 > Math.min(start, end) &&
            along - object.dimensions.width / 2 < Math.max(start, end)
          )
            return "This wall placement covers a door or window.";
        }
      }
    }
  }
  if (object.mount === "wall" && !wallContact)
    return "Wall decor must stay against a wall and clear of openings.";
  if (object.category !== "rug" && object.mount !== "wall") {
    const blocked = model.clearances.find((zone) =>
      overlap(body.footprint, zone.footprint),
    );
    if (blocked)
      return `This placement blocks doorway clearance. ${blocked.reason}`;
  }
  for (const other of model.obstacles) {
    if (
      other.id === object.id ||
      other.id === object.supportId ||
      other.category === "rug" ||
      object.category === "rug"
    )
      continue;
    const obstacle = other;
    if (
      body.bottom < obstacle.top - EPS &&
      body.top > obstacle.bottom + EPS &&
      overlap(body.footprint, obstacle.footprint)
    )
      return `This placement overlaps ${other.name}.`;
  }
  return null;
}

/** Stable capture categories for free-form merchant labels. */
export function productCategory(category: string): RoomObject["category"] {
  const value = category.toLowerCase();
  const matches: [RegExp, RoomObject["category"]][] = [
    [
      /nightstand|dresser|cabinet|shelf|shelves|wardrobe|bookcase|storage/,
      "storage",
    ],
    [/lamp|light|sconce|chandelier/, "lighting"],
    [/rug|carpet/, "rug"],
    [/\bart\b|artwork|painting|print|poster|mirror|decor/, "art"],
    [/sofa|couch|loveseat/, "sofa"],
    [/chair|stool|bench/, "chair"],
    [/desk/, "desk"],
    [/table/, "table"],
    [/bed/, "bed"],
  ];
  return matches.find(([pattern]) => pattern.test(value))?.[1] ?? "unknown";
}

export function productObject(
  product: ProductCandidate,
  id: string,
): RoomObject {
  if (product.availability !== "available")
    throw new Error("This product is not currently available.");
  if (!product.measurement.dimensions)
    throw new Error(
      "Product dimensions are unknown. Confirm them before placement.",
    );
  const category = productCategory(product.category);
  return {
    id,
    productId: product.id,
    assetId: product.assetId ?? `${product.id}-asset`,
    name: product.name,
    category,
    dimensions: product.measurement.dimensions,
    color: product.color,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    measurementSource:
      product.measurement.source === "confirmed" ? "confirmed" : "estimated",
    owned: false,
    locked: false,
    productLocked: false,
    mount: category === "rug" ? "under" : "floor",
  };
}

export function objectInZone(
  room: RoomSnapshot,
  product: ProductCandidate,
  id: string,
  zone: ReservedZone,
): RoomObject {
  const object = productObject(product, id);
  object.mount = zone.mount;
  object.zoneId = zone.id;
  object.position = { ...zone.position };
  object.rotation.y = zone.rotationY;
  const { width, depth, height } = object.dimensions;
  if (
    zone.mount !== "wall" &&
    (width > zone.footprint.width + EPS || depth > zone.footprint.depth + EPS)
  ) {
    if (
      depth <= zone.footprint.width + EPS &&
      width <= zone.footprint.depth + EPS
    )
      object.rotation.y += Math.PI / 2;
    else throw new Error(`${product.name} is too large for this spot.`);
  }
  if (zone.maxHeight !== null && height > zone.maxHeight + EPS)
    throw new Error(`${product.name} is too tall for this spot.`);
  if (zone.mount === "wall") {
    if (width > zone.footprint.width + EPS)
      throw new Error("This product is wider than the reserved wall space.");
    const offset = (depth - zone.footprint.depth) / 2 + 0.01;
    object.position.x += Math.sin(zone.rotationY) * offset;
    object.position.z += Math.cos(zone.rotationY) * offset;
  }
  if (zone.mount === "surface") {
    const host = room.objects.find(
      (item) =>
        item.id === zone.relatedObjectId ||
        item.zoneId === zone.relatedObjectId,
    );
    if (!host) throw new Error("Place the supporting table or cabinet first.");
    object.supportId = host.id;
    object.position.y = objectObstacle(host).top;
  } else if (zone.mount !== "wall")
    object.position.y = buildSpaceModel(room).floorY;
  return object;
}

/** Find a nearby valid placement without changing a locked object's position. */
export function suggestPlacement(
  room: RoomSnapshot,
  object: RoomObject,
): RoomObject | null {
  if (object.locked || object.mount === "wall" || object.mount === "surface")
    return null;
  if (room.shape === "polygon" && !room.floors.length) return null;
  const model = buildSpaceModel(room);
  const options: { x: number; z: number }[] = [];
  const step = Math.max(
    0.2,
    Math.max(room.dimensions.width, room.dimensions.depth) / 80,
  );
  for (let x = 0.1; x < room.dimensions.width; x += step)
    for (let z = 0.1; z < room.dimensions.depth; z += step)
      options.push({ x, z });
  options.sort(
    (a, b) =>
      Math.hypot(a.x - object.position.x, a.z - object.position.z) -
      Math.hypot(b.x - object.position.x, b.z - object.position.z),
  );
  for (const point of options) {
    for (const yaw of [object.rotation.y, object.rotation.y + Math.PI / 2]) {
      const candidate = {
        ...object,
        position: { x: point.x, y: model.floorY, z: point.z },
        rotation: { ...object.rotation, y: yaw },
      };
      if (!designPlacementIssue(room, candidate, model)) return candidate;
    }
  }
  return null;
}

export function prefersSurface(product: ProductCandidate): boolean {
  const label = `${product.category} ${product.name}`.toLowerCase();
  return (
    /table lamp|desk lamp|bedside lamp|vase|bookend|candle|tabletop|shelf decor/.test(
      label,
    ) ||
    (/plant|succulent|bonsai/.test(label) &&
      (product.measurement.dimensions?.height ?? Infinity) <= 0.6)
  );
}

export function autoPlaceProduct(
  room: RoomSnapshot,
  product: ProductCandidate,
  id: string,
  nearObjectId?: string,
): RoomObject | null {
  const object = productObject(product, id);
  const anchor = room.objects.find((item) => item.id === nearObjectId);
  if (nearObjectId && !anchor)
    throw new Error(
      "The nearby furniture was removed. Choose another reference.",
    );
  if (prefersSurface(product)) {
    const model = buildSpaceModel(room);
    const withoutSelf = {
      ...room,
      objects: room.objects.filter((item) => item.id !== id),
    };
    const hosts = withoutSelf.objects.filter(
      (item) =>
        ["table", "desk", "storage"].includes(item.category) &&
        !/sink|vanity|toilet|shower|bath|wardrobe|rail|rack|ironing/i.test(
          item.name,
        ) &&
        Math.abs(item.rotation.x) < 0.02 &&
        Math.abs(item.rotation.z) < 0.02 &&
        objectObstacle(item).top >= model.floorY + 0.35 &&
        objectObstacle(item).top <= model.floorY + 1.5,
    );
    const target =
      anchor?.position ??
      room.objects.find(
        (item) => item.category === "bed" || item.category === "sofa",
      )?.position;
    hosts.sort((a, b) =>
      target
        ? Math.hypot(a.position.x - target.x, a.position.z - target.z) -
          Math.hypot(b.position.x - target.x, b.position.z - target.z)
        : 0,
    );
    for (const host of hosts) {
      for (const turn of [0, Math.PI / 2]) {
        const width = turn ? object.dimensions.depth : object.dimensions.width;
        const depth = turn ? object.dimensions.width : object.dimensions.depth;
        const dx = (host.dimensions.width - width) / 2 - 0.025;
        const dz = (host.dimensions.depth - depth) / 2 - 0.025;
        if (dx < 0 || dz < 0) continue;
        for (const [x, z] of [
          [0, 0],
          [-dx, -dz],
          [dx, -dz],
          [-dx, dz],
          [dx, dz],
          [0, -dz],
          [0, dz],
        ]) {
          const yaw = host.rotation.y;
          const candidate: RoomObject = {
            ...object,
            mount: "surface",
            supportId: host.id,
            position: {
              x: host.position.x + x * Math.cos(yaw) + z * Math.sin(yaw),
              y: objectObstacle(host).top,
              z: host.position.z - x * Math.sin(yaw) + z * Math.cos(yaw),
            },
            rotation: { x: 0, y: yaw + turn, z: 0 },
          };
          if (!designPlacementIssue(withoutSelf, candidate, model))
            return candidate;
        }
      }
    }
    return null;
  }
  if (object.category !== "art") {
    object.position = anchor
      ? { ...anchor.position }
      : {
          x: room.dimensions.width / 2,
          y: 0,
          z: room.dimensions.depth / 2,
        };
    return suggestPlacement(room, object);
  }
  const model = buildSpaceModel(room);
  const result = reserveZones(
    room,
    model,
    [
      {
        id: `wall-${id}`,
        purpose: product.name,
        category: product.category,
        query: product.name,
        mount: "wall",
        anchor: "wall",
        relatedObjectId: null,
        desiredFootprint: {
          width: object.dimensions.width,
          depth: object.dimensions.depth,
        },
        desiredHeight: object.dimensions.height,
        miscellaneous: [],
        priority: 1,
      },
    ],
    "balanced",
  );
  const zone = result.zones[0];
  if (!zone) return null;
  const placed = objectInZone(room, product, id, zone);
  return designPlacementIssue(room, placed, model) ? null : placed;
}
