import { describe, expect, test } from "bun:test";
import { importRoomPlan } from "../shared/capture/roomplan";
import {
  createWalkthrough,
  moveWalk,
  WALK_RADIUS,
  walkPosition,
} from "../shared/capture/walkthrough";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";

const sample = () => importRoomPlan(syntheticRoomPlan, "Walk test", true);

describe("first-person navigation", () => {
  test("spawns on clear captured floor in a furnished concave room", () => {
    const model = createWalkthrough(sample());
    expect(model.start).not.toBeNull();
    expect(walkPosition(model, model.start!, model.start!.y)).toEqual(
      model.start,
    );
    expect(walkPosition(model, { x: 0.65, z: 1.7 }, 0)).toBeNull();
  });

  test("does not invent walkable floor inside the L-shaped room's bounding box", () => {
    const room = sample();
    room.objects = [];
    const model = createWalkthrough(room);
    expect(walkPosition(model, { x: 5, z: 4 }, 0)).toBeNull();
    const result = moveWalk(model, { x: 5, y: 0, z: 2 }, 0, 10);
    expect(result.z).toBeLessThanOrEqual(3.2 - WALK_RADIUS + 0.001);
    expect(result.z).toBeGreaterThan(2.8);
  });

  test("stops long movement at furniture instead of tunneling through it", () => {
    const room = sample();
    room.objects = [
      {
        ...room.objects[0],
        position: { x: 2, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        dimensions: { width: 0.1, height: 1, depth: 2 },
      },
    ];
    const model = createWalkthrough(room);
    const result = moveWalk(model, { x: 1, y: 0, z: 2 }, 4, 0);
    expect(result.x).toBeLessThanOrEqual(1.75);
    expect(result.x).toBeGreaterThan(1.5);
  });

  test("uses rotated footprints without blocking the entire axis-aligned box", () => {
    const room = sample();
    room.objects = [
      {
        ...room.objects[0],
        position: { x: 2.5, y: 0, z: 2 },
        rotation: { x: 0, y: Math.PI / 4, z: 0 },
        dimensions: { width: 2, height: 1, depth: 0.3 },
      },
    ];
    const model = createWalkthrough(room);
    expect(walkPosition(model, { x: 2.5, z: 2 }, 0)).toBeNull();
    expect(walkPosition(model, { x: 3.15, z: 2.65 }, 0)).not.toBeNull();
  });

  test("slides along walls and stays inside at door openings", () => {
    const room = sample();
    room.objects = [];
    const model = createWalkthrough(room);
    const slide = moveWalk(model, { x: 1, y: 0, z: 1 }, -3, 2);
    expect(slide.x).toBeGreaterThanOrEqual(WALK_RADIUS - 0.001);
    expect(slide.z).toBeGreaterThan(2.8);
    const doorway = moveWalk(model, { x: 1, y: 0, z: 4 }, 0, 2);
    expect(doorway.z).toBeLessThanOrEqual(4.6 - WALK_RADIUS + 0.001);
  });

  test("blocks internal wall segments even when the floor extends beyond them", () => {
    const room = sample();
    room.objects = [];
    const wall = structuredClone(room.walls[0]);
    wall.transform[12] = 2.9;
    wall.transform[14] = 2;
    room.walls.push(wall);
    const model = createWalkthrough(room);
    expect(moveWalk(model, { x: 2, y: 0, z: 1 }, 0, 3).z).toBeLessThanOrEqual(
      1.8,
    );
  });

  test("does not start without a floor, on steep floors, or with no standing room", () => {
    const room = sample();
    room.floors = [];
    expect(createWalkthrough(room).start).toBeNull();
    const tilted = sample();
    tilted.floors[0].transform[5] = 0.5;
    expect(createWalkthrough(tilted).start).toBeNull();
    const blocked = sample();
    blocked.objects = [
      {
        ...blocked.objects[0],
        position: { x: 2.9, y: 0, z: 2.3 },
        rotation: { x: 0, y: 0, z: 0 },
        dimensions: { width: 6, height: 2, depth: 5 },
      },
    ];
    expect(createWalkthrough(blocked).start).toBeNull();
  });

  test("does not jump to a floor at a different elevation", () => {
    const room = sample();
    room.objects = [];
    room.floors[0].transform[13] = 0.5;
    const model = createWalkthrough(room);
    expect(model.start?.y).toBe(0.5);
    expect(walkPosition(model, { x: 2, z: 2 }, 0)).toBeNull();
    expect(walkPosition(model, { x: 2, z: 2 }, 0.5)?.y).toBe(0.5);
  });

  test("allows a low rug but blocks a tilted furniture footprint", () => {
    const room = sample();
    room.objects = [
      {
        ...room.objects[0],
        position: { x: 2, y: 0, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        dimensions: { width: 2, height: 0.02, depth: 2 },
      },
    ];
    expect(
      walkPosition(createWalkthrough(room), { x: 2, z: 2 }, 0),
    ).not.toBeNull();
    room.objects[0].dimensions = { width: 0.3, height: 2, depth: 0.3 };
    room.objects[0].rotation.z = Math.PI / 4;
    expect(walkPosition(createWalkthrough(room), { x: 1, z: 2 }, 0)).toBeNull();
  });
});
