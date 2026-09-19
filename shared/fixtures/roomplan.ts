// Synthetic, independently authored RoomPlan-shaped input. Not a measured scan.
const outline = [
  [0, 0],
  [5.8, 0],
  [5.8, 3.2],
  [3.8, 3.2],
  [3.8, 4.6],
  [0, 4.6],
];
const height = 2.7;
function frame(x: number, y: number, z: number, yaw = 0) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1];
}
const walls = outline.map(([x, z], index) => {
  const [nextX, nextZ] = outline[(index + 1) % outline.length];
  return {
    identifier: `sample-wall-${index}`,
    dimensions: [Math.hypot(nextX - x, nextZ - z), height, 0],
    transform: frame(
      (x + nextX) / 2,
      height / 2,
      (z + nextZ) / 2,
      -Math.atan2(nextZ - z, nextX - x),
    ),
    category: { wall: {} },
    confidence: { high: {} },
    polygonCorners: [],
    parentIdentifier: null,
  };
});
function object(
  id: string,
  category: string,
  size: number[],
  x: number,
  z: number,
  yaw = 0,
) {
  return {
    identifier: id,
    category: { [category]: {} },
    dimensions: size,
    transform: frame(x, size[1] / 2, z, yaw),
    confidence: { high: {} },
    attributes: {},
  };
}
export const syntheticRoomPlan = {
  version: 2,
  walls,
  floors: [
    {
      identifier: "sample-floor",
      dimensions: [5.8, 4.6, 0],
      transform: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
      polygonCorners: outline.map(([x, z]) => [x, z, 0]),
      category: { floor: {} },
      confidence: { high: {} },
    },
  ],
  doors: [
    {
      identifier: "sample-door",
      dimensions: [0.9, 2.1, 0],
      transform: frame(1, 1.05, 4.6, Math.PI),
      category: { door: { isOpen: false } },
      confidence: { high: {} },
      parentIdentifier: "sample-wall-4",
    },
  ],
  windows: [
    {
      identifier: "sample-window",
      dimensions: [1.8, 1.2, 0],
      transform: frame(3.7, 1.6, 0),
      category: { window: {} },
      confidence: { medium: {} },
      parentIdentifier: "sample-wall-0",
    },
  ],
  openings: [],
  objects: [
    object("sample-sofa", "sofa", [2.15, 0.85, 0.92], 0.65, 1.7, Math.PI / 2),
    object(
      "sample-coffee-table",
      "table",
      [1.1, 0.42, 0.6],
      2,
      1.7,
      Math.PI / 2,
    ),
    object("sample-cabinet", "storage", [1.4, 0.85, 0.42], 4.1, 0.3),
    object(
      "sample-chair",
      "chair",
      [0.72, 0.8, 0.76],
      3.05,
      2.55,
      -Math.PI / 5,
    ),
    object("sample-shelf", "storage", [1.15, 1.7, 0.38], 2.7, 4.3),
  ],
};
