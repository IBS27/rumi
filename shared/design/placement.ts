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

// Scanned walls and floors are estimates. A footprint may cross the measured
// line by this much and still count as inside the room and clear of the wall;
// otherwise the scan's own furniture fails its own boundary.
const SCAN_TOLERANCE = 0.15;

function toleratedFootprint(object: RoomObject): Ring {
  const { width, depth } = object.dimensions;
  return rectangleRing(
    { x: object.position.x, z: object.position.z },
    Math.max(0.05, width - 2 * SCAN_TOLERANCE),
    Math.max(0.05, depth - 2 * SCAN_TOLERANCE),
    object.rotation.y,
  );
}

export function designPlacementIssue(
  room: RoomSnapshot,
  object: RoomObject,
  model = buildSpaceModel(room),
): string | null {
  const body = objectObstacle(object);
  const tolerated = toleratedFootprint(object);
  if (
    body.bottom < model.floorY - EPS ||
    body.top > model.floorY + room.dimensions.height + EPS
  )
    return "This item extends below the floor or above the ceiling.";
  if (room.shape === "polygon" && !room.floors.length)
    return "This scan has no measured floor. Import a scan with a floor before placing furniture.";
  // A hung piece lives on the wall line; the wall-contact rule below is its
  // boundary check.
  if (object.mount !== "wall" && !insideFloor(room, tolerated, model))
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
    if (object.mount !== "wall" && overlap(tolerated, strip))
      return "This placement crosses a wall.";
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
  // The reservation is where the piece goes, not a box it must fit. A piece
  // larger than the reservation is turned if that helps, then placed there;
  // the room check below decides whether it truly fits, and a piece that
  // overruns is slid to the nearest clear spot around the reservation.
  if (
    zone.mount !== "wall" &&
    (width > zone.footprint.width + EPS || depth > zone.footprint.depth + EPS) &&
    depth <= zone.footprint.width + EPS &&
    width <= zone.footprint.depth + EPS
  )
    object.rotation.y += Math.PI / 2;
  if (zone.maxHeight !== null && height > zone.maxHeight + EPS)
    throw new Error(`${product.name} is too tall for this spot.`);
  if (zone.mount === "wall") {
    // Hang it on the wall the zone sits against: project onto the nearest
    // wall segment, face into the room, keep it within the wall's length.
    snapToWall(room, object);
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
  } else if (zone.mount !== "wall") {
    const model = buildSpaceModel(room);
    object.position.y = model.floorY;
    if (designPlacementIssue(room, object, model)) {
      // Slide the piece around the reservation until it is clear: toward the
      // room first (off a wall it overruns), then sideways, in 5 cm steps up
      // to half a metre, keeping the zone's rotation.
      const c = Math.cos(zone.rotationY), s = Math.sin(zone.rotationY);
      const start = { ...object.position };
      const found = SLIDE_STEPS.some((step) => {
        object.position = {
          ...start,
          x: start.x + step.forward * s + step.side * c,
          z: start.z + step.forward * c - step.side * s,
        };
        return !designPlacementIssue(room, object, model);
      });
      if (!found) {
        object.position = start;
        const nearby = suggestPlacement(room, object);
        if (!nearby)
          throw new Error(
            `${product.name} does not fit at its reserved spot or nearby.`,
          );
        object.position = nearby.position;
        object.rotation = nearby.rotation;
      }
    }
  }
  return object;
}

// Put a hung piece flat on the nearest wall: its back on the wall line, its
// face toward the room, its span inside the wall's length (clamped to the
// wall when it is wider, so a long print still hangs rather than failing).
function snapToWall(room: RoomSnapshot, object: RoomObject): void {
  const model = buildSpaceModel(room);
  const center = model.floor[0]?.reduce(
    (sum, point) => ({
      x: sum.x + point.x / model.floor[0].length,
      z: sum.z + point.z / model.floor[0].length,
    }),
    { x: 0, z: 0 },
  ) ?? { x: room.dimensions.width / 2, z: room.dimensions.depth / 2 };
  let best: { distance: number; x: number; z: number; yaw: number } | null = null;
  for (const wall of model.walls) {
    const dx = wall.end.x - wall.start.x, dz = wall.end.z - wall.start.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const ux = dx / length, uz = dz / length;
    const rawAlong =
      (object.position.x - wall.start.x) * ux + (object.position.z - wall.start.z) * uz;
    const half = Math.min(object.dimensions.width / 2, length / 2);
    const along = Math.min(Math.max(rawAlong, half), length - half);
    const footX = wall.start.x + ux * along, footZ = wall.start.z + uz * along;
    const distance = Math.hypot(object.position.x - footX, object.position.z - footZ);
    if (best && distance >= best.distance) continue;
    // The inward normal points toward the floor's center.
    let nx = -uz, nz = ux;
    if ((center.x - footX) * nx + (center.z - footZ) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const inset = object.dimensions.depth / 2 + 0.005;
    best = {
      distance,
      x: footX + nx * inset,
      z: footZ + nz * inset,
      yaw: Math.atan2(nx, nz),
    };
  }
  if (!best) return;
  object.position.x = Math.round(best.x * 1000) / 1000;
  object.position.z = Math.round(best.z * 1000) / 1000;
  object.rotation.y = best.yaw + 0;
}

// Offsets from the reservation, nearest first: along the piece's facing
// (forward = away from the wall behind it) and across it.
const SLIDE_STEPS: { forward: number; side: number }[] = (() => {
  const steps: { forward: number; side: number }[] = [];
  for (let distance = 0.05; distance <= 0.5; distance += 0.05)
    for (const [forward, side] of [
      [distance, 0], [0, distance], [0, -distance], [distance, distance],
      [distance, -distance], [-distance, 0],
    ])
      steps.push({ forward, side });
  return steps;
})();

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
