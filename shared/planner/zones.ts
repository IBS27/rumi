import type {
  RoomObject,
  ReservedZone,
  RoomSnapshot,
  ZoneRejection,
  ZoneRequest,
} from "../contracts";
import type { Spacing, ZoneMount } from "../contracts";
import { sameCategory, SPACING_FACTOR } from "./scope";
import {
  FURNITURE_GAP,
  WALK_PATH,
  rectangleRing,
  ringInside,
  ringsOverlap,
  type Point2,
  type Ring,
  type SpaceModel,
  type WallSegment,
} from "./space";

const MIN_FOOTPRINT = 0.25;
const POSITION_ROUNDING_PAD = 0.01;
// Positions are reported to the centimeter.
const cm = (value: number) => Math.round(value * 100) / 100 + 0;
// Shrinking past 70% turns the request into a different piece of furniture, so
// the planner reports a rejection instead and lets the model rethink the zone.
const SHRINK_STEPS = [1, 0.9, 0.8, 0.7];

interface FootprintOption {
  width: number;
  depth: number;
  sizeName: string | null;
}

const BED_SIZES: { sizeName: string; width: number; depth: number }[] = [
  // Approximate compact FRAME envelopes, not bare mattress dimensions.
  // These become hard product-search ceilings; actual merchant dimensions
  // still have to fit, and bulkier frames may need a larger reservation.
  { sizeName: "king", width: 2.05, depth: 2.2 },
  { sizeName: "queen", width: 1.65, depth: 2.15 },
  { sizeName: "full", width: 1.5, depth: 2.05 },
  { sizeName: "twin", width: 1.1, depth: 2.05 },
];

function isBed(category: string): boolean {
  return /\bbed\b|\bdaybed\b|murphy bed/i.test(category);
}

function bedSizeName(width: number): string {
  if (width >= 1.75) return "king";
  if (width >= 1.52) return "queen";
  if (width >= 1.2) return "full";
  return "twin";
}

function footprintOptions(request: ZoneRequest): FootprintOption[] {
  const desired = request.desiredFootprint;
  if (!isBed(request.category))
    return SHRINK_STEPS.map((factor) => ({
      width: Math.max(MIN_FOOTPRINT, desired.width * factor),
      depth: Math.max(MIN_FOOTPRINT, desired.depth * factor),
      sizeName: null,
    }));

  // Beds are sold in standard sizes. Proportional shrinking can create a
  // physically meaningless 1.15 × 1.50 m "queen" zone that no product can
  // satisfy. Try the requested maximum, then smaller real sizes in order.
  const options: FootprintOption[] = [
    {
      width: desired.width,
      depth: desired.depth,
      sizeName: bedSizeName(desired.width),
    },
    ...BED_SIZES.filter(
      (size) =>
        size.width < desired.width - 0.02 &&
        size.depth <= desired.depth + 0.02,
    ),
  ];
  return options.filter(
    (option, index) =>
      options.findIndex(
        (candidate) =>
          Math.abs(candidate.width - option.width) < 0.01 &&
          Math.abs(candidate.depth - option.depth) < 0.01,
      ) === index,
  );
}

function queryForSize(query: string, sizeName: string | null): string {
  if (!sizeName) return query;
  const size = /\b(?:california king|king|queen|full|double|twin|single)\b/i;
  return size.test(query)
    ? query.replace(size, sizeName)
    : `${sizeName} ${query}`;
}

interface Margins {
  front: number;
  back: number;
  sides: number;
}

// Clearance is a property of how a piece is used, not of the model's wording.
export function marginsFor(category: string): Margins {
  const value = category.toLowerCase();
  if (isBed(value)) return { front: 0.75, back: 0.05, sides: 0.6 };
  if (/desk|vanity|workstation/.test(value))
    return { front: 0.9, back: 0.05, sides: 0.3 };
  if (/dining|table/.test(value)) return { front: 0.9, back: 0.9, sides: 0.9 };
  if (/sofa|couch|sectional|loveseat/.test(value))
    return { front: 0.75, back: 0.1, sides: 0.3 };
  if (/chair|stool|bench|ottoman/.test(value))
    return { front: 0.6, back: 0.1, sides: 0.3 };
  if (/wardrobe|dresser|cabinet|bookcase|shelf|storage|console/.test(value))
    return { front: 0.75, back: 0.02, sides: 0.15 };
  if (/lamp|light|plant|art|mirror/.test(value))
    return { front: 0.3, back: 0.02, sides: 0.15 };
  if (/rug/.test(value)) return { front: 0, back: 0, sides: 0 };
  return { front: WALK_PATH, back: 0.05, sides: FURNITURE_GAP };
}

// A person still needs to get past the piece and open it, whatever the style.
// A cozy plan may not scale a clearance below the walking minimum, or below
// the category's own value when that is already smaller (a lamp needs 0.3 m).
const MIN_FRONT = 0.6;
const MIN_SIDES = 0.1;

// Small rooms cannot always spare a full walkway. The last-resort tier keeps
// a squeezable strip in front and a minimal gap beside furniture; walls may
// still cut side clearance. The zone records the honest margins it used.
const TIGHT_FRONT = 0.45;
const TIGHT_BACK = 0.02;

function marginTiers(margins: Margins, mount: ZoneMount): Margins[] {
  if (mount !== "floor") return [margins];
  const tight: Margins = {
    front: Math.min(margins.front, TIGHT_FRONT),
    back: Math.min(margins.back, TIGHT_BACK),
    sides: Math.min(margins.sides, MIN_SIDES),
  };
  return tight.front < margins.front ||
    tight.back < margins.back ||
    tight.sides < margins.sides
    ? [margins, tight]
    : [margins];
}

export function scaleMargins(margins: Margins, spacing: Spacing): Margins {
  const factor = SPACING_FACTOR[spacing];
  const round = (value: number) => Math.round(value * 100) / 100;
  const scale = (value: number, minimum: number) =>
    value === 0 ? 0 : round(Math.max(Math.min(value, minimum), value * factor));
  return {
    front: scale(margins.front, MIN_FRONT),
    back: margins.back,
    sides: scale(margins.sides, MIN_SIDES),
  };
}

function reservationRing(
  center: Point2,
  width: number,
  depth: number,
  rotationY: number,
  margins: Margins,
): Ring {
  // Front is +Z in the object's local frame, so front clearance pushes the
  // reservation further into the room.
  const totalWidth = width + margins.sides * 2;
  const totalDepth = depth + margins.front + margins.back;
  const shift = (margins.front - margins.back) / 2;
  const c = Math.cos(rotationY),
    s = Math.sin(rotationY);
  return rectangleRing(
    { x: center.x + shift * s, z: center.z + shift * c },
    totalWidth,
    totalDepth,
    rotationY,
  );
}

// The strip a person needs in front of the piece. Unlike side clearance, a
// wall may never cut into it.
function frontRing(
  center: Point2,
  width: number,
  depth: number,
  rotationY: number,
  margins: Margins,
): Ring {
  const shift = depth / 2 + margins.front / 2;
  const c = Math.cos(rotationY),
    s = Math.sin(rotationY);
  return rectangleRing(
    { x: center.x + shift * s, z: center.z + shift * c },
    width,
    Math.max(margins.front, 0.01),
    rotationY,
  );
}

function candidatePositions(
  model: SpaceModel,
  request: ZoneRequest,
  width: number,
  depth: number,
  margins: Margins,
  zones: ReservedZone[] = [],
  placementHint: RoomObject | null = null,
): { position: Point2; rotationY: number }[] {
  // Captured floor polygons can be inset from the scan's wall-derived bounds.
  // Candidate coordinates must follow the actual walkable polygon, not assume
  // that it starts at (0, 0), or wall-aligned furniture gets pushed outside.
  const floorPoints = model.floor.flat();
  const minX = floorPoints.length
    ? Math.min(...floorPoints.map((point) => point.x))
    : 0;
  const maxX = floorPoints.length
    ? Math.max(...floorPoints.map((point) => point.x))
    : model.bounds.width;
  const minZ = floorPoints.length
    ? Math.min(...floorPoints.map((point) => point.z))
    : 0;
  const maxZ = floorPoints.length
    ? Math.max(...floorPoints.map((point) => point.z))
    : model.bounds.depth;
  const roomWidth = maxX - minX;
  const roomDepth = maxZ - minZ;
  const candidates: { position: Point2; rotationY: number }[] = [];
  const push = (x: number, z: number, rotationY: number) =>
    candidates.push({ position: { x, z }, rotationY });
  // An item removed through the editor was valid at this exact location. Try
  // that footprint before the generic grid when planning a replacement of the
  // same category.
  if (placementHint)
    push(
      placementHint.position.x,
      placementHint.position.z,
      placementHint.rotation.y,
    );
  const object = request.relatedObjectId
    ? model.obstacles.find((obstacle) => obstacle.id === request.relatedObjectId)
    : null;
  const host = request.relatedObjectId
    ? zones.find((zone) => zone.id === request.relatedObjectId)
    : null;
  const related = object
    ? object.footprint
    : host
      ? rectangleRing({ x: host.position.x, z: host.position.z }, host.footprint.width, host.footprint.depth, host.rotationY)
      : null;
  if (related) {
    const xs = related.map((point) => point.x);
    const zs = related.map((point) => point.z);
    const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    const halfWidth = (Math.max(...xs) - Math.min(...xs)) / 2;
    const halfDepth = (Math.max(...zs) - Math.min(...zs)) / 2;
    // Hug the host: a small gap, then a few steps further out.
    for (const gap of [0.05, 0.15, 0.3]) {
      const dx = halfWidth + gap + width / 2;
      const dz = halfDepth + gap + depth / 2;
      // Alongside, at the host's back edge, then at its center.
      for (const t of [-0.5, 0, 0.5]) {
        push(center.x + dx, center.z + t * halfDepth, 0);
        push(center.x - dx, center.z + t * halfDepth, 0);
        push(center.x + t * halfWidth, center.z + dz, 0);
        push(center.x + t * halfWidth, center.z - dz, 0);
      }
    }
  }
  // Back edge against the wall; the reservation ring already holds the margin.
  const wallInset = depth / 2 + margins.back + 0.02;
  const sideInset = width / 2 + margins.sides + 0.02;
  const steps = 24;
  const walls = () => {
    // The scan's X/Z bounds are not its walls. Follow the measured floor
    // edges, including inset/rotated edges, and try both normals (the full
    // polygon fit check chooses the inward one, even in concave rooms).
    for (const floor of model.shape === "polygon" ? model.floor : []) {
      for (let edge = 0; edge < floor.length; edge++) {
        const start = floor[edge];
        const end = floor[(edge + 1) % floor.length];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        if (length < width + 2 * POSITION_ROUNDING_PAD) continue;
        const dx = (end.x - start.x) / length;
        const dz = (end.z - start.z) / length;
        const alongInset = width / 2 + POSITION_ROUNDING_PAD;
        const span = length - 2 * alongInset;
        const samples = Math.max(1, Math.ceil(span / 0.1));
        for (const side of [-1, 1]) {
          const nx = -dz * side, nz = dx * side;
          // A shallow wall fitting can prevent flush placement without
          // preventing furniture a little further into the room.
          for (const offset of [0, 0.1, 0.2, 0.3]) {
            for (let i = 0; i <= samples; i++) {
              const along = alongInset + span * i / samples;
              push(
                start.x + dx * along + nx * (wallInset + offset),
                start.z + dz * along + nz * (wallInset + offset),
                Math.atan2(nx, nz),
              );
            }
          }
        }
      }
    }
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = minX + sideInset + t * Math.max(0, roomWidth - 2 * sideInset);
      const z = minZ + sideInset + t * Math.max(0, roomDepth - 2 * sideInset);
      push(x, minZ + wallInset, 0);
      push(x, maxZ - wallInset, Math.PI);
      push(minX + wallInset, z, Math.PI / 2);
      push(maxX - wallInset, z, -Math.PI / 2);
    }
  };
  const corners = () => {
    push(minX + sideInset, minZ + wallInset, 0);
    push(maxX - sideInset, minZ + wallInset, 0);
    push(minX + sideInset, maxZ - wallInset, Math.PI);
    push(maxX - sideInset, maxZ - wallInset, Math.PI);
  };
  // A known piece can leave a narrow but valid slot beside it. Align candidate
  // clearances exactly to obstacle edges so a normal 0.6 m bedside passage is
  // discoverable even when a uniform grid does not land on it.
  const obstacles = () => {
    for (const obstacle of model.obstacles) {
      const xs = obstacle.footprint.map((point) => point.x);
      const zs = obstacle.footprint.map((point) => point.z);
      const left = Math.min(...xs), right = Math.max(...xs);
      const back = Math.min(...zs), front = Math.max(...zs);
      const obstacleX = (left + right) / 2;
      const obstacleZ = (back + front) / 2;
      const wallZs = [minZ + wallInset, maxZ - wallInset, obstacleZ];
      for (const z of wallZs) {
        push(
          left - margins.sides - width / 2 - POSITION_ROUNDING_PAD,
          z,
          0,
        );
        push(
          right + margins.sides + width / 2 + POSITION_ROUNDING_PAD,
          z,
          0,
        );
      }
      const wallXs = [minX + sideInset, maxX - sideInset, obstacleX];
      for (const x of wallXs) {
        push(
          x,
          back - margins.front - depth / 2 - POSITION_ROUNDING_PAD,
          0,
        );
        push(
          x,
          front + margins.back + depth / 2 + POSITION_ROUNDING_PAD,
          0,
        );
      }
    }
  };
  const center = () => {
    push((minX + maxX) / 2, (minZ + maxZ) / 2, 0);
    for (let i = 1; i < 12; i++)
      for (let j = 1; j < 12; j++)
        push(minX + (roomWidth * i) / 12, minZ + (roomDepth * j) / 12, 0);
  };
  // Try the requested anchor first, then the others, so a zone is only
  // rejected when no anchor in the room can hold it.
  const order: Record<ZoneRequest["anchor"], (() => void)[]> = {
    wall: [walls, obstacles, corners, center],
    window: [walls, obstacles, corners, center],
    corner: [corners, walls, obstacles, center],
    center: [center, obstacles, walls, corners],
    "near-object": [obstacles, walls, corners, center],
    anywhere: [walls, obstacles, corners, center],
  };
  order[request.anchor].forEach((generate) => generate());
  return candidates;
}

function isRug(category: string): boolean {
  return /rug|carpet/i.test(category);
}

// The model may leave mount at "floor" for an obvious accessory; the category
// still tells us where it lives.
export function mountFor(request: Pick<ZoneRequest, "mount" | "category">): ZoneMount {
  if (request.mount !== "floor") return request.mount;
  const value = request.category.toLowerCase();
  if (isRug(value)) return "under";
  if (/\bart\b|painting|wall art|artwork|print|poster|mirror|wall shelf|sconce|tapestry|clock/.test(value))
    return "wall";
  if (/table lamp|desk lamp|bedside lamp|vase|tray|sculpture|bookend|candle|small plant|desk organizer/.test(value))
    return "surface";
  return "floor";
}

const WALL_HANG_BOTTOM = 1.2;
const WALL_EDGE_GAP = 0.15;

// Categories whose top is a usable surface for a small accessory.
function isSurfaceHost(category: string): boolean {
  return /table|desk|dresser|nightstand|console|sideboard|shelf|cabinet|counter|credenza|bench|vanity/i.test(
    category,
  );
}

// A floor reservation keeps both rings: the piece itself, and the piece plus
// its clearance. A companion (nightstand by a bed) may stand in the host's
// clearance but never on the host.
type Reservation = { zoneId: string; body: Ring; withMargins: Ring };

function fits(
  model: SpaceModel,
  body: Ring,
  front: Ring,
  ring: Ring,
  reserved: Reservation[],
  mount: ZoneMount,
  hostId: string | null,
): string | null {
  // The piece and the room in front of it must be inside the floor. Side
  // clearance may be cut by a wall: a nightstand can stand against one.
  if (!ringInside(body, model.floor)) return "outside the floor";
  if (mount !== "under" && !ringInside(front, model.floor))
    return "faces a wall";
  // A rug lies under furniture. It only needs to be on the floor and clear of
  // the door swing, the same exemption placementIssue gives it.
  if (mount === "under") {
    const clearance = model.clearances.find((zone) =>
      ringsOverlap(ring, zone.footprint),
    );
    return clearance ? clearance.reason : null;
  }
  const blocking = model.obstacles.find(
    (obstacle) =>
      obstacle.category !== "rug" && ringsOverlap(ring, obstacle.footprint),
  );
  if (blocking) return `overlaps ${blocking.name}`;
  // A bedside/foot walkway may share the doorway's empty walking space.
  // Only furniture bodies block it, as in final designPlacementIssue checks.
  const clearance = model.clearances.find((zone) =>
    ringsOverlap(body, zone.footprint),
  );
  if (clearance) return clearance.reason;
  for (const other of reserved) {
    // Two clearances may overlap: that is a shared walkway. A body may not
    // enter another piece's clearance, and no clearance may cover a body.
    // A companion (host given) may also stand inside its host's clearance.
    if (ringsOverlap(body, other.body)) return "overlaps another reserved zone";
    if (other.zoneId === hostId) continue;
    if (ringsOverlap(body, other.withMargins))
      return "stands in another piece's clearance";
    if (ringsOverlap(ring, other.body))
      return "its clearance would cover another piece";
  }
  return null;
}

type WallSpan = { wallId: string; from: number; to: number };

function wallLength(wall: WallSegment): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
}

function alongWall(wall: WallSegment, point: Point2): number {
  const length = wallLength(wall) || 1;
  return (
    ((point.x - wall.start.x) * (wall.end.x - wall.start.x) +
      (point.z - wall.start.z) * (wall.end.z - wall.start.z)) /
    length
  );
}

// Hang on a wall: a span of wall free of openings, other hung pieces, and tall
// floor furniture standing against that stretch of wall.
function reserveOnWall(
  model: SpaceModel,
  request: ZoneRequest,
  hung: WallSpan[],
  maxRoomHeight: number,
): { zone: Omit<ReservedZone, "priority">; span: WallSpan } | string {
  const width = request.desiredFootprint.width;
  const depth = Math.min(request.desiredFootprint.depth, 0.2);
  let issue = "no wall span is long enough";
  for (const wall of model.walls) {
    const length = wallLength(wall);
    if (length < width + 2 * WALL_EDGE_GAP) continue;
    const blocked: [number, number][] = [
      ...wall.openings.map(
        (opening): [number, number] => [
          Math.min(alongWall(wall, opening.start), alongWall(wall, opening.end)),
          Math.max(alongWall(wall, opening.start), alongWall(wall, opening.end)),
        ],
      ),
      ...hung
        .filter((span) => span.wallId === wall.id)
        .map((span): [number, number] => [span.from, span.to]),
      // Tall furniture against this wall covers the hanging height.
      ...model.obstacles
        .filter((obstacle) => obstacle.top > WALL_HANG_BOTTOM)
        .map((obstacle): [number, number] | null => {
          const along = obstacle.footprint.map((point) => alongWall(wall, point));
          const distances = obstacle.footprint.map((point) => {
            const t = Math.max(0, Math.min(length, alongWall(wall, point)));
            const cx = wall.start.x + ((wall.end.x - wall.start.x) * t) / length;
            const cz = wall.start.z + ((wall.end.z - wall.start.z) * t) / length;
            return Math.hypot(point.x - cx, point.z - cz);
          });
          return Math.min(...distances) < 0.3
            ? [Math.min(...along), Math.max(...along)]
            : null;
        })
        .filter((span): span is [number, number] => span !== null),
    ];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const center = WALL_EDGE_GAP + width / 2 + (i / steps) * (length - width - 2 * WALL_EDGE_GAP);
      const from = center - width / 2 - WALL_EDGE_GAP;
      const to = center + width / 2 + WALL_EDGE_GAP;
      const hit = blocked.find(([a, b]) => from < b && to > a);
      if (hit) {
        issue = `wall ${wall.id} is taken by an opening or another piece there`;
        continue;
      }
      const dx = (wall.end.x - wall.start.x) / length;
      const dz = (wall.end.z - wall.start.z) / length;
      // Face into the room: the inward normal points toward the floor center.
      const floorCenter = model.floor[0].reduce(
        (sum, point) => ({ x: sum.x + point.x / model.floor[0].length, z: sum.z + point.z / model.floor[0].length }),
        { x: 0, z: 0 },
      );
      const px = wall.start.x + dx * center;
      const pz = wall.start.z + dz * center;
      let nx = -dz, nz = dx;
      if ((floorCenter.x - px) * nx + (floorCenter.z - pz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const availableHeight = Math.min(wall.height, maxRoomHeight) - WALL_HANG_BOTTOM - 0.2;
      if (availableHeight < 0.2) {
        issue = "the wall is too low to hang anything";
        continue;
      }
      return {
        span: { wallId: wall.id, from, to },
        zone: {
          id: request.id,
          purpose: request.purpose,
          category: request.category,
          query: request.query,
          mount: "wall",
          anchor: "wall",
          relatedObjectId: null,
          position: { x: cm(px + nx * (depth / 2)), y: WALL_HANG_BOTTOM, z: cm(pz + nz * (depth / 2)) },
          rotationY: Math.atan2(nx, nz) + 0,
          footprint: { width: Math.round(width * 100) / 100, depth: Math.round(depth * 100) / 100 },
          maxHeight: Math.round(availableHeight * 100) / 100,
          margins: { front: 0, back: 0, sides: WALL_EDGE_GAP },
          clearanceRules: [
            `Hangs on wall ${wall.id} with its bottom edge about ${WALL_HANG_BOTTOM} m above the floor.`,
            `Keep ${WALL_EDGE_GAP} m from openings and other hung pieces.`,
          ],
          miscellaneous: [...request.miscellaneous, "wall mounted"].slice(0, 12),
          suggested: false,
        },
      };
    }
  }
  return issue;
}

// Sit on top of a host: an existing object with a usable top, or a zone
// reserved earlier in this plan for such a piece.
function reserveOnSurface(
  model: SpaceModel,
  request: ZoneRequest,
  zones: ReservedZone[],
  surfaceUse: Map<string, number>,
  maxRoomHeight: number,
): Omit<ReservedZone, "priority"> | string {
  if (!request.relatedObjectId)
    return "a surface piece needs relatedObjectId naming what it sits on";
  const object = model.obstacles.find((item) => item.id === request.relatedObjectId);
  const host = zones.find((zone) => zone.id === request.relatedObjectId);
  let top: { center: Point2; width: number; depth: number; rotationY: number; y: number | null; category: string; label: string };
  if (object) {
    const xs = object.footprint.map((point) => point.x);
    const zs = object.footprint.map((point) => point.z);
    top = {
      center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 },
      width: Math.max(...xs) - Math.min(...xs),
      depth: Math.max(...zs) - Math.min(...zs),
      rotationY: 0,
      y: object.top,
      category: object.category,
      label: object.name,
    };
  } else if (host && host.mount === "floor") {
    top = {
      center: { x: host.position.x, z: host.position.z },
      width: host.footprint.width,
      depth: host.footprint.depth,
      rotationY: host.rotationY,
      // The host's height is unknown until its product is chosen.
      y: null,
      category: host.category,
      label: host.purpose,
    };
  } else return `no object or reserved zone with id ${request.relatedObjectId}`;
  if (!isSurfaceHost(top.category))
    return `${top.label} (${top.category}) has no top to put things on`;
  const used = surfaceUse.get(request.relatedObjectId) ?? 0;
  const inset = 0.05;
  const availableWidth = top.width - 2 * inset - used;
  const availableDepth = top.depth - 2 * inset;
  const width = Math.min(request.desiredFootprint.width, availableWidth);
  const depth = Math.min(request.desiredFootprint.depth, availableDepth);
  if (width < 0.1 || depth < 0.1)
    return `${top.label} has no room left on top`;
  // Fill from one end so several accessories can share the same surface.
  const offset = -top.width / 2 + inset + used + width / 2;
  const c = Math.cos(top.rotationY), s = Math.sin(top.rotationY);
  surfaceUse.set(request.relatedObjectId, used + width + inset);
  const y = top.y ?? model.floorY;
  return {
    id: request.id,
    purpose: request.purpose,
    category: request.category,
    query: request.query,
    mount: "surface",
    anchor: "near-object",
    relatedObjectId: request.relatedObjectId,
    position: { x: cm(top.center.x + offset * c), y: cm(y), z: cm(top.center.z - offset * s) },
    rotationY: top.rotationY,
    footprint: { width: Math.round(width * 100) / 100, depth: Math.round(depth * 100) / 100 },
    maxHeight: Math.round((maxRoomHeight - (top.y ?? 0.75) - 0.1) * 100) / 100,
    margins: { front: 0, back: 0, sides: inset },
    clearanceRules: [
      top.y === null
        ? `Sits on top of ${top.label}; final height follows the chosen host product.`
        : `Sits on top of ${top.label} at ${top.y.toFixed(2)} m.`,
    ],
    miscellaneous: request.miscellaneous,
    suggested: false,
  };
}

export function reserveZones(
  room: RoomSnapshot,
  model: SpaceModel,
  requests: ZoneRequest[],
  spacing: Spacing = "balanced",
  maxRoomHeight = room.dimensions.height,
  placementHints: RoomObject[] = [],
): { zones: ReservedZone[]; rejected: ZoneRejection[] } {
  const zones: ReservedZone[] = [];
  const rejected: ZoneRejection[] = [];
  const reserved: Reservation[] = [];
  const hung: WallSpan[] = [];
  const surfaceUse = new Map<string, number>();
  // Hosts first, then what stands on or hangs near them.
  const rank: Record<ZoneMount, number> = { floor: 0, under: 1, wall: 2, surface: 3 };
  const ordered = [...requests].sort(
    (a, b) => rank[mountFor(a)] - rank[mountFor(b)] || a.priority - b.priority,
  );
  for (const request of ordered) {
    const mount = mountFor(request);
    if (mount === "wall") {
      const result = reserveOnWall(model, request, hung, maxRoomHeight);
      if (typeof result === "string")
        rejected.push({ zoneId: request.id, reason: `Could not hang ${request.category}: ${result}.` });
      else {
        hung.push(result.span);
        zones.push({ ...result.zone, priority: zones.length + 1 });
      }
      continue;
    }
    if (mount === "surface") {
      const result = reserveOnSurface(model, request, zones, surfaceUse, maxRoomHeight);
      if (typeof result === "string")
        rejected.push({ zoneId: request.id, reason: `Could not place ${request.category}: ${result}.` });
      else zones.push({ ...result, priority: zones.length + 1 });
      continue;
    }
    const margins = scaleMargins(
      mount === "under" ? marginsFor("rug") : marginsFor(request.category),
      spacing,
    );
    let placed: ReservedZone | null = null;
    const placementHint = placementHints.find((object) =>
      sameCategory(object.category, request.category),
    ) ?? null;
    const issues = new Map<string, number>();
    let lastIssue = "no free floor space";
    // Comfortable clearances first; if no size fits, retighten and retry so a
    // small room rejects only when the piece truly cannot fit.
    outer: for (const active of marginTiers(margins, mount)) {
      for (const option of footprintOptions(request)) {
        const width = cm(option.width), depth = cm(option.depth);
        for (const candidate of candidatePositions(
          model,
          request,
          width,
          depth,
          active,
          zones,
          placementHint,
        )) {
        // Validate exactly the coordinates that will be persisted/searched.
        candidate.position = { x: cm(candidate.position.x), z: cm(candidate.position.z) };
        const ring = reservationRing(
          candidate.position,
          width,
          depth,
          candidate.rotationY,
          active,
        );
        const body = rectangleRing(candidate.position, width, depth, candidate.rotationY);
        const front = frontRing(candidate.position, width, depth, candidate.rotationY, active);
        const issue = fits(model, body, front, ring, reserved, mount, request.relatedObjectId);
        if (issue) {
          issues.set(issue, (issues.get(issue) ?? 0) + 1);
          continue;
        }
        // Rugs do not claim floor from later zones.
        if (mount === "floor")
          reserved.push({ zoneId: request.id, body, withMargins: ring });
        placed = {
          id: request.id,
          purpose: request.purpose,
          category: request.category,
          query: queryForSize(request.query, option.sizeName),
          mount,
          anchor: request.anchor,
          relatedObjectId: request.relatedObjectId,
          position: { x: cm(candidate.position.x), y: model.floorY, z: cm(candidate.position.z) },
          // + 0 turns -0 into 0 so the value serializes as a plain number.
          rotationY: candidate.rotationY + 0,
          footprint: {
            width: Math.round(width * 100) / 100,
            depth: Math.round(depth * 100) / 100,
          },
          // The room is the only hard height ceiling. A desired height is a
          // hint for search, not a limit that would reject a taller product.
          maxHeight: Math.round((maxRoomHeight - 0.1) * 100) / 100,
          margins: active,
          clearanceRules: [
            `Keep ${active.front} m in front for use and walking.`,
            ...(active.sides > 0 ? [`Keep ${active.sides} m on each side.`] : []),
            ...model.clearances.map((zone) => zone.reason),
          ],
          miscellaneous: [
            ...request.miscellaneous,
            ...(option.sizeName
              ? [
                  `${option.sizeName} size, about ${width.toFixed(2)} × ${depth.toFixed(2)} m`,
                ]
              : []),
            ...(request.desiredHeight
              ? [`about ${request.desiredHeight} m tall`]
              : []),
          ].slice(0, 12),
          priority: zones.length + 1,
          suggested: false,
        };
        break outer;
        }
      }
    }
    if (placed) zones.push(placed);
    else {
      // Report the most common blocker, which is the one the user can act on.
      for (const [issue, count] of issues)
        if (count > (issues.get(lastIssue) ?? 0)) lastIssue = issue;
      rejected.push({
        zoneId: request.id,
        reason: `Could not reserve ${request.desiredFootprint.width} × ${request.desiredFootprint.depth} m for ${request.category}: ${lastIssue}.`,
      });
    }
  }
  return { zones, rejected };
}
