import { describe, expect, it } from "bun:test";
import { Matrix4 } from "three";
import type { RoomObject, RoomSnapshot } from "../shared/contracts";
import { sampleRoom } from "../shared/fixtures";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { importRoomPlan } from "../shared/capture/roomplan";
import { placementIssue } from "../shared/geometry";
import { designPlacementIssue } from "../shared/design/placement";
import { buildSpaceModel, freeSpaceContains } from "../shared/planner/space";

// The same west-wall door, centered at z = 2.3, in a rectangle room and in a
// scan. The scan can be rotated as a whole about the origin by `yaw`.
const DOOR_CENTER = 2.3;

function rectangleRoom(
  width = 0.9,
  wall: "north" | "west" = "west",
  offset = DOOR_CENTER - width / 2,
): RoomSnapshot {
  if (sampleRoom.shape !== "rectangle")
    throw new Error("Expected a rectangle room.");
  return {
    ...sampleRoom,
    objects: [],
    openings: [
      {
        id: `${wall}-door`,
        kind: "door",
        wall,
        offset,
        width,
        height: 2.1,
        sill: 0,
      },
    ],
  };
}

function scannedRoom(yaw = 0, width = 0.9): RoomSnapshot {
  const room = importRoomPlan(syntheticRoomPlan);
  const door = room.openings.find((opening) => opening.kind === "door")!;
  room.objects = [];
  room.openings = [
    {
      ...door,
      parentId: "sample-wall-5",
      dimensions: { ...door.dimensions, width },
      transform: new Matrix4()
        .makeRotationY(Math.PI / 2)
        .setPosition(0, 1.05, DOOR_CENTER)
        .toArray(),
    },
  ];
  const rotation = new Matrix4().makeRotationY(yaw);
  for (const surface of [...room.floors, ...room.walls, ...room.openings])
    surface.transform = rotation
      .clone()
      .multiply(new Matrix4().fromArray(surface.transform))
      .toArray();
  return room;
}

function probe(x: number, z: number, yaw = 0, size = 0.1): RoomObject {
  return {
    id: "probe",
    name: "Cabinet",
    category: "storage",
    productId: null,
    assetId: null,
    dimensions: { width: size, height: 0.5, depth: size },
    position: {
      x: x * Math.cos(yaw) + z * Math.sin(yaw),
      y: 0,
      z: -x * Math.sin(yaw) + z * Math.cos(yaw),
    },
    rotation: { x: 0, y: yaw, z: 0 },
    color: "#ffffff",
    owned: true,
    locked: false,
  };
}

const blocksDoor = (issue: string | null) =>
  issue?.includes("doorway clearance") ?? false;

// Points on an inward-opening leaf for either hinge jamb, from nearly closed
// to fully open, far enough off the wall for a probe not to touch it.
function leafPoints(width: number): { x: number; z: number }[] {
  const points = [];
  for (const [hingeZ, along] of [
    [DOOR_CENTER - width / 2, 1],
    [DOOR_CENTER + width / 2, -1],
  ])
    for (const degrees of [10, 30, 45, 60, 80])
      for (const fraction of [0.35, 0.65, 0.9]) {
        const angle = (degrees * Math.PI) / 180;
        const radius = fraction * width;
        points.push({
          x: radius * Math.sin(angle),
          z: hingeZ + along * radius * Math.cos(angle),
        });
      }
  return points.filter((point) => point.x > 0.06);
}

describe("door clearance", () => {
  it("keeps the whole swing of an inward-opening door clear", () => {
    // A cabinet the leaf of a 0.9 m north door hinged at x = 1 hits at 45°.
    const north = rectangleRoom(0.9, "north", 1);
    const cabinet = probe(1.55, 0.55, 0, 0.2);
    expect(placementIssue(north, cabinet)).not.toBeNull();
    expect(designPlacementIssue(north, cabinet)).not.toBeNull();

    for (const width of [0.9, 0.7]) {
      const rectangle = rectangleRoom(width);
      const rectangleModel = buildSpaceModel(rectangle);
      for (const yaw of [0, Math.PI / 2, 0.63]) {
        const scan = scannedRoom(yaw, width);
        const scanModel = buildSpaceModel(scan);
        for (const { x, z } of leafPoints(width)) {
          const object = probe(x, z, yaw, 0.08);
          expect(
            blocksDoor(placementIssue(rectangle, probe(x, z, 0, 0.08))),
          ).toBe(true);
          expect(blocksDoor(designPlacementIssue(scan, object))).toBe(true);
          expect(freeSpaceContains(rectangleModel, { x, z })).toBe(false);
          expect(freeSpaceContains(scanModel, object.position)).toBe(false);
        }
      }
    }
  });

  it("turns the scanned door clearance with the measured doorway", () => {
    for (const yaw of [0, Math.PI / 2, 0.63]) {
      const scan = scannedRoom(yaw);
      // Just inside the doorway beside the jamb: in the leaf's path.
      const nearJamb = probe(0.1, 2.68, yaw);
      expect(blocksDoor(designPlacementIssue(scan, nearJamb))).toBe(true);
      expect(freeSpaceContains(buildSpaceModel(scan), nearJamb.position)).toBe(
        false,
      );
    }
  });

  it("frees the floor past the swing and beside the jambs", () => {
    for (const width of [0.9, 0.7]) {
      // A dresser 2 cm off the west wall, 1 cm past the jamb, and a small
      // cabinet 1 cm past the swing.
      const beside = {
        ...probe(0.27, DOOR_CENTER + width / 2 + 0.41),
        dimensions: { width: 0.5, height: 0.9, depth: 0.8 },
      };
      const past = probe(width + 0.06, DOOR_CENTER);
      const rectangle = rectangleRoom(width);
      for (const object of [beside, past]) {
        expect(placementIssue(rectangle, object)).toBeNull();
        expect(designPlacementIssue(rectangle, object)).toBeNull();
      }
      for (const yaw of [0, 0.63]) {
        const scan = scannedRoom(yaw, width);
        for (const object of [beside, past]) {
          const turned = probe(object.position.x, object.position.z, yaw);
          expect(
            designPlacementIssue(scan, {
              ...turned,
              dimensions: object.dimensions,
            }),
          ).toBeNull();
        }
      }
    }
  });

  it("gives scans and rectangle rooms the same door clearance", () => {
    const rectangle = rectangleRoom();
    // Probe edges never land exactly on a clearance edge.
    for (let x = 0.07; x < 1.3; x += 0.1)
      for (let z = 1.43; z < 3.2; z += 0.1) {
        const expected = blocksDoor(placementIssue(rectangle, probe(x, z)));
        expect(blocksDoor(designPlacementIssue(rectangle, probe(x, z)))).toBe(
          expected,
        );
        for (const yaw of [0, 0.63])
          expect(
            blocksDoor(
              designPlacementIssue(scannedRoom(yaw), probe(x, z, yaw)),
            ),
          ).toBe(expected);
      }
  });
});
