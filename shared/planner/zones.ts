import type {
  ReservedZone,
  RoomSnapshot,
  ZoneRejection,
  ZoneRequest,
} from "../contracts";
import type { Spacing, ZoneMount } from "../contracts";
import { SPACING_FACTOR } from "./scope";
import type { Slot } from "./slots";
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
// Positions are reported to the centimeter.
const cm = (value: number) => Math.round(value * 100) / 100 + 0;
// Shrinking past 70% turns the request into a different piece of furniture, so
// the planner reports a rejection instead and lets the model rethink the zone.
const SHRINK_STEPS = [1, 0.9, 0.8, 0.7];

// Beds come in standard sizes. Scaling a queen by 0.9 asks the shops for a
// bed nobody makes; stepping to the next size down asks for one they do.
// Footprints include a typical frame around the mattress.
const BED_SIZES: { name: string; pattern: RegExp; width: number; depth: number }[] = [
  { name: "king", pattern: /\bking\b/i, width: 2.0, depth: 2.15 },
  { name: "queen", pattern: /\bqueen\b/i, width: 1.6, depth: 2.1 },
  { name: "full", pattern: /\b(full|double)\b/i, width: 1.45, depth: 2.0 },
  { name: "twin", pattern: /\b(twin|single)\b/i, width: 1.05, depth: 2.0 },
];

// We shop US stores. UK size names pull in UK retailers, which are then
// dropped for their currency, so the words are translated before search.
const UK_BED_TERMS: [RegExp, string][] = [
  [/\bsmall double\b/gi, "full"],
  [/\bdouble\b/gi, "full"],
  [/\bsuper king\b/gi, "king"],
  [/\bking[- ]size\b/gi, "king"],
  [/\bsingle\b/gi, "twin"],
];
export function usBedTerms(text: string): string {
  return UK_BED_TERMS.reduce((value, [pattern, us]) => value.replace(pattern, us), text);
}

interface SizeStep {
  width: number;
  depth: number;
  // Wording changes that go with the size, applied to category and query.
  rename: ((text: string) => string) | null;
  // True when the step is a smaller size than the one requested.
  renamed?: boolean;
}

// The sizes to try for a request, largest first. Beds walk the standard
// ladder from the requested size down; everything else shrinks by steps.
function sizeSteps(request: ZoneRequest): SizeStep[] {
  const words = usBedTerms(`${request.category} ${request.query}`);
  if (/\bbed\b/i.test(request.category) && !/\bbedside|bed bench\b/i.test(request.category)) {
    const start = BED_SIZES.findIndex((size) => size.pattern.test(words));
    const from = start === -1 ? BED_SIZES.findIndex((size) => size.name === "queen") : start;
    const named = BED_SIZES[from];
    // A standard size is the size: the model's guess at a footprint does not
    // shrink it, or the zone would reject every bed of the size it names.
    return BED_SIZES.slice(from).map((size) => ({
      width: size.width,
      depth: size.depth,
      rename: (text) => {
        const us = usBedTerms(text);
        if (size.name === named.name) return us;
        return named.pattern.test(us) ? us.replace(named.pattern, size.name) : `${size.name} ${us}`;
      },
      renamed: size.name !== named.name,
    }));
  }
  return SHRINK_STEPS.map((factor) => ({
    width: Math.max(MIN_FOOTPRINT, request.desiredFootprint.width * factor),
    depth: Math.max(MIN_FOOTPRINT, request.desiredFootprint.depth * factor),
    rename: null,
  }));
}

interface Margins {
  front: number;
  back: number;
  sides: number;
}

// Clearance is a property of how a piece is used, not of the model's wording.
export function marginsFor(category: string): Margins {
  const value = category.toLowerCase();
  // Rooms are furnished tightly in practice: enough to use the piece and
  // squeeze past, not showroom spacing. Only the front strip is hard.
  if (/bed/.test(value)) return { front: 0.5, back: 0.05, sides: 0.4 };
  // Seating first: a "desk chair" or "dining chair" is a chair, not a desk.
  if (/chair|stool|bench|ottoman/.test(value))
    return { front: 0.45, back: 0.05, sides: 0.15 };
  if (/desk|vanity|workstation/.test(value))
    return { front: 0.6, back: 0.05, sides: 0.15 };
  if (/dining|table/.test(value)) return { front: 0.6, back: 0.6, sides: 0.6 };
  if (/sofa|couch|sectional|loveseat/.test(value))
    return { front: 0.5, back: 0.05, sides: 0.15 };
  if (/wardrobe|dresser|cabinet|bookcase|shelf|storage|console/.test(value))
    return { front: 0.5, back: 0.02, sides: 0.1 };
  if (/lamp|light|plant|art|mirror/.test(value))
    return { front: 0.2, back: 0.02, sides: 0.1 };
  if (/rug/.test(value)) return { front: 0, back: 0, sides: 0 };
  return { front: WALK_PATH, back: 0.05, sides: FURNITURE_GAP };
}

// A person still needs to get past the piece and open it, whatever the style.
// A cozy plan may not scale a clearance below the walking minimum, or below
// the category's own value when that is already smaller (a lamp needs 0.2 m).
const MIN_FRONT = 0.45;
const MIN_SIDES = 0.05;

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

// The strip a person needs in front of the piece to use it and pass by. The
// full front margin shapes where candidates go; only this much of it is hard,
// so a tight real room (a bed with 0.3 m at its foot) is still furnishable.
const HARD_FRONT = 0.3;

function frontRing(
  center: Point2,
  width: number,
  depth: number,
  rotationY: number,
  margins: Margins,
): Ring {
  const front = Math.min(margins.front, HARD_FRONT);
  const shift = depth / 2 + front / 2;
  const c = Math.cos(rotationY),
    s = Math.sin(rotationY);
  return rectangleRing(
    { x: center.x + shift * s, z: center.z + shift * c },
    width,
    Math.max(front, 0.01),
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
  slot: Slot | null = null,
): { position: Point2; rotationY: number }[] {
  const { width: roomWidth, depth: roomDepth } = model.bounds;
  const candidates: { position: Point2; rotationY: number }[] = [];
  const push = (x: number, z: number, rotationY: number) =>
    candidates.push({ position: { x, z }, rotationY });
  // The slot the model chose comes first: back edge on the slot's wall edge,
  // centred along it, then nudged along the wall if the centre is taken.
  if (slot) {
    const s = Math.sin(slot.rotationY), c = Math.cos(slot.rotationY);
    const backX = slot.center.x - s * (slot.depth / 2);
    const backZ = slot.center.z - c * (slot.depth / 2);
    const inset = depth / 2 + margins.back + 0.02;
    const slack = Math.max(0, (slot.width - width) / 2);
    for (const along of [0, slack / 2, -slack / 2, slack, -slack])
      push(backX + s * inset + c * along, backZ + c * inset - s * along, slot.rotationY);
  }
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
  // Positions come from the room's actual wall segments, so an irregular
  // scan (a notch, a bathroom, an angled wall) offers its real walls and not
  // the edges of its bounding box. The piece faces away from the wall.
  const floorCenter = model.floor[0].reduce(
    (sum, point) => ({
      x: sum.x + point.x / model.floor[0].length,
      z: sum.z + point.z / model.floor[0].length,
    }),
    { x: 0, z: 0 },
  );
  const segments = model.walls
    .map((wall) => {
      const length = Math.hypot(wall.end.x - wall.start.x, wall.end.z - wall.start.z);
      if (length < 0.2) return null;
      const dx = (wall.end.x - wall.start.x) / length;
      const dz = (wall.end.z - wall.start.z) / length;
      const mid = { x: (wall.start.x + wall.end.x) / 2, z: (wall.start.z + wall.end.z) / 2 };
      let nx = -dz, nz = dx;
      if ((floorCenter.x - mid.x) * nx + (floorCenter.z - mid.z) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      // Local +Z (the front) must point along the inward normal.
      return { wall, length, dx, dz, nx, nz, rotationY: Math.atan2(nx, nz) };
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);
  const alongWallAt = (segment: (typeof segments)[number], t: number) => ({
    x: segment.wall.start.x + segment.dx * t + segment.nx * wallInset,
    z: segment.wall.start.z + segment.dz * t + segment.nz * wallInset,
  });
  const walls = () => {
    for (const segment of segments) {
      if (segment.length < width) continue;
      const usable = Math.max(0, segment.length - 2 * sideInset);
      const steps = Math.max(1, Math.min(8, Math.round(usable / 0.25)));
      for (let i = 0; i <= steps; i++) {
        const t = sideInset + (usable * i) / steps;
        const spot = alongWallAt(segment, Math.min(Math.max(t, width / 2), segment.length - width / 2));
        push(spot.x, spot.z, segment.rotationY);
      }
    }
  };
  const corners = () => {
    for (const segment of segments) {
      if (segment.length < width) continue;
      for (const t of [sideInset, segment.length - sideInset]) {
        const spot = alongWallAt(segment, Math.min(Math.max(t, width / 2), segment.length - width / 2));
        push(spot.x, spot.z, segment.rotationY);
      }
    }
  };
  const center = () => {
    push(roomWidth / 2, roomDepth / 2, 0);
    for (let i = 1; i < 6; i++)
      for (let j = 1; j < 6; j++)
        push((roomWidth * i) / 6, (roomDepth * j) / 6, 0);
  };
  // Try the requested anchor first, then the others, so a zone is only
  // rejected when no anchor in the room can hold it.
  const order: Record<ZoneRequest["anchor"], (() => void)[]> = {
    wall: [walls, corners, center],
    window: [walls, corners, center],
    corner: [corners, walls, center],
    center: [center, walls, corners],
    "near-object": [walls, corners, center],
    anywhere: [walls, corners, center],
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
  if (/\bart\b|painting|wall art|artwork|print|poster|mirror|wall shelf|sconce|tapestry|clock|curtain|drape/.test(value))
    return "wall";
  if (/table lamp|desk lamp|bedside lamp|vase|tray|sculpture|bookend|candle|small plant|desk organizer/.test(value))
    return "surface";
  return "floor";
}

const WALL_HANG_BOTTOM = 1.2;
const WALL_EDGE_GAP = 0.15;
const WALL_TOP_GAP = 0.2;
// An object whose underside is above this is wall- or ceiling-mounted and
// leaves the floor beneath it free.
const OVERHEAD_BOTTOM = 0.9;

function isCurtain(category: string): boolean {
  return /curtain|drape/i.test(category);
}

// Pieces that stand or hang from near the floor rather than at eye level.
function hangsLow(category: string): boolean {
  return /full[- ]length|floor mirror|leaner|standing mirror|tall shelf|curtain|drape/i.test(
    category,
  );
}

// Where the bottom edge goes, and how tall the piece may be. Eye-level pieces
// hang at 1.2 m; a piece too tall for that drops until it fits under the top
// gap; floor-length pieces start near the floor.
function hangingRange(
  request: Pick<ZoneRequest, "category" | "desiredHeight">,
  wallHeight: number,
): { bottom: number; maxHeight: number } {
  const ceiling = wallHeight - WALL_TOP_GAP;
  let bottom = hangsLow(request.category) ? 0.1 : WALL_HANG_BOTTOM;
  if (request.desiredHeight && bottom + request.desiredHeight > ceiling)
    bottom = Math.max(0.1, ceiling - request.desiredHeight);
  return {
    bottom: Math.round(bottom * 100) / 100,
    maxHeight: Math.round(Math.max(0, ceiling - bottom) * 100) / 100,
  };
}

// Categories whose top is a usable surface for a small accessory. A scan
// labels dressers and chests simply "storage".
function isSurfaceHost(category: string): boolean {
  return /table|desk|dresser|nightstand|console|sideboard|shelf|cabinet|counter|credenza|bench|vanity|storage|chest/i.test(
    category,
  );
}

// Soft goods lie on seating and beds rather than on a hard top.
function isSoftGood(category: string): boolean {
  return /throw|blanket|pillow|cushion|bedding|duvet|quilt|comforter/i.test(category);
}

function isSoftHost(category: string): boolean {
  return /bed|sofa|couch|sectional|loveseat|chair|bench|ottoman|daybed/i.test(category);
}

// A floor reservation keeps both rings: the piece itself, and the piece plus
// its clearance. A companion (nightstand by a bed) may stand in the host's
// clearance but never on the host.
type Reservation = { zoneId: string; body: Ring; front: Ring; withMargins: Ring };

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
  // Only the front strip is a hard clearance: a person must be able to stand
  // there. Side clearance is a preference that shapes candidate positions,
  // never a reason to reject. Two fronts may overlap (a shared walkway); a
  // body may not stand in a front, and a front may not cover a body. The host
  // a companion belongs beside is exempt. Things mounted above waist height
  // (a wall mirror, a towel rack, a ceiling light) do not take floor.
  for (const obstacle of model.obstacles) {
    if (obstacle.category === "rug" || obstacle.bottom > OVERHEAD_BOTTOM) continue;
    if (ringsOverlap(body, obstacle.footprint)) return `overlaps ${obstacle.name}`;
    if (obstacle.id !== hostId && ringsOverlap(front, obstacle.footprint))
      return `${obstacle.name} would block its front`;
  }
  const clearance = model.clearances.find(
    (zone) => ringsOverlap(body, zone.footprint) || ringsOverlap(front, zone.footprint),
  );
  if (clearance) return clearance.reason;
  for (const other of reserved) {
    if (ringsOverlap(body, other.body)) return "overlaps another reserved zone";
    if (other.zoneId === hostId) continue;
    if (ringsOverlap(body, other.front)) return "stands in front of another piece";
    if (ringsOverlap(front, other.body)) return "another piece would block its front";
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
  const depth = Math.min(request.desiredFootprint.depth, 0.2);
  const curtain = isCurtain(request.category);
  let issue = curtain ? "no window to dress" : "no wall span is long enough";
  for (const wall of model.walls) {
    const length = wallLength(wall);
    const spanOf = (opening: { start: Point2; end: Point2 }): [number, number] => [
      Math.min(alongWall(wall, opening.start), alongWall(wall, opening.end)),
      Math.max(alongWall(wall, opening.start), alongWall(wall, opening.end)),
    ];
    const windows = wall.openings.filter((opening) => opening.kind === "window");
    // Curtains dress a window: the span is the window plus an overhang on
    // each side, and only that wall's windows are candidates.
    if (curtain && windows.length === 0) continue;
    const width = curtain
      ? Math.max(
          ...windows.map((window) => {
            const [a, b] = spanOf(window);
            return b - a;
          }),
        ) + 0.4
      : request.desiredFootprint.width;
    if (length < width + 2 * WALL_EDGE_GAP) continue;
    const { bottom, maxHeight } = hangingRange(request, Math.min(wall.height, maxRoomHeight));
    const blocked: [number, number][] = [
      ...wall.openings
        .filter((opening) => !(curtain && opening.kind === "window"))
        .map(spanOf),
      ...hung
        .filter((span) => span.wallId === wall.id)
        .map((span): [number, number] => [span.from, span.to]),
      // Furniture against this wall that rises into the hanging range.
      ...model.obstacles
        .filter((obstacle) => obstacle.top > bottom)
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
    // Curtains center on each window; other pieces try positions along the wall.
    const centers = curtain
      ? windows.map((window) => {
          const [a, b] = spanOf(window);
          return (a + b) / 2;
        })
      : Array.from({ length: 13 }, (_, i) =>
          WALL_EDGE_GAP + width / 2 + (i / 12) * (length - width - 2 * WALL_EDGE_GAP),
        );
    for (const center of centers) {
      const from = center - width / 2 - WALL_EDGE_GAP;
      const to = center + width / 2 + WALL_EDGE_GAP;
      if (from < 0 || to > length) {
        issue = `the window on wall ${wall.id} sits too close to a corner for curtains`;
        continue;
      }
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
      if (maxHeight < 0.2) {
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
          position: { x: cm(px + nx * (depth / 2)), y: bottom, z: cm(pz + nz * (depth / 2)) },
          rotationY: Math.atan2(nx, nz) + 0,
          footprint: { width: Math.round(width * 100) / 100, depth: Math.round(depth * 100) / 100 },
          maxHeight,
          margins: { front: 0, back: 0, sides: WALL_EDGE_GAP },
          clearanceRules: [
            curtain
              ? `Dresses the window on wall ${wall.id}; panels may run to the floor.`
              : `Hangs on wall ${wall.id} with its bottom edge about ${bottom} m above the floor.`,
            `Keep ${WALL_EDGE_GAP} m from openings and other hung pieces.`,
          ],
          miscellaneous: [
            ...request.miscellaneous,
            curtain ? "window curtains" : "wall mounted",
          ].slice(0, 12),
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
  const soft = isSoftGood(request.category) && isSoftHost(top.category);
  if (!isSurfaceHost(top.category) && !soft)
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
  slots: Slot[] = [],
): { zones: ReservedZone[]; rejected: ZoneRejection[] } {
  const usedSlots = new Set<string>();
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
    const issues = new Map<string, number>();
    let lastIssue = "no free floor space";
    // A floor piece goes into the slot the model chose, sized to that slot.
    // One piece per slot; a taken slot falls back to the free search.
    const slot =
      mount === "floor" && request.slotId && !usedSlots.has(request.slotId)
        ? slots.find((item) => item.id === request.slotId) ?? null
        : null;
    const fitted = slot
      ? {
          ...request,
          desiredFootprint: {
            width: Math.min(request.desiredFootprint.width, slot.width - 0.04),
            depth: Math.min(request.desiredFootprint.depth, slot.depth - 0.04),
          },
        }
      : request;
    outer: for (const step of sizeSteps(fitted)) {
      const { width, depth } = step;
      // A standard size (a bed) may be larger than the model's guess; it must
      // still fit the slot, or the next size down is tried.
      if (slot && (width > slot.width + 0.01 || depth > slot.depth + 0.01)) continue;
      for (const candidate of candidatePositions(model, request, width, depth, margins, zones, slot)) {
        const ring = reservationRing(
          candidate.position,
          width,
          depth,
          candidate.rotationY,
          margins,
        );
        const body = rectangleRing(candidate.position, width, depth, candidate.rotationY);
        const front = frontRing(candidate.position, width, depth, candidate.rotationY, margins);
        const issue = fits(model, body, front, ring, reserved, mount, request.relatedObjectId);
        if (issue) {
          issues.set(issue, (issues.get(issue) ?? 0) + 1);
          continue;
        }
        // Rugs do not claim floor from later zones.
        if (mount === "floor")
          reserved.push({ zoneId: request.id, body, front, withMargins: ring });
        if (slot) usedSlots.add(slot.id);
        // A stepped-down bed is searched by its new size, not the old name.
        const rename = step.rename ?? ((text: string) => text);
        placed = {
          id: request.id,
          purpose: request.purpose,
          category: rename(request.category),
          query: rename(request.query),
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
          margins,
          clearanceRules: [
            ...(step.renamed
              ? [`Sized down to a ${rename("bed")} so it fits the room.`]
              : []),
            `Keep ${margins.front} m in front for use and walking.`,
            ...(margins.sides > 0 ? [`Keep ${margins.sides} m on each side.`] : []),
            ...model.clearances.map((zone) => zone.reason),
          ],
          miscellaneous: [
            ...request.miscellaneous,
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
    if (placed) zones.push(placed);
    else {
      // Report the blocker the user can act on. A piece they placed can be
      // moved, so it ranks first; a scanned object or door next; "outside
      // the floor", which every tiny wall segment produces, last.
      const movable = room.objects.filter((object) => !object.owned && !object.locked);
      const rank = (issue: string) =>
        movable.some((object) => issue.includes(object.name))
          ? 0
          : issue === "outside the floor" || issue === "faces a wall"
            ? 2
            : 1;
      const ranked = [...issues].sort(
        (a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1],
      );
      if (ranked.length) lastIssue = ranked[0][0];
      const hint =
        rank(lastIssue) === 0 ? " Move or remove it to make room." : "";
      rejected.push({
        zoneId: request.id,
        reason: `Could not reserve ${request.desiredFootprint.width} × ${request.desiredFootprint.depth} m for ${request.category}: ${lastIssue}.${hint}`,
      });
    }
  }
  return { zones, rejected };
}
