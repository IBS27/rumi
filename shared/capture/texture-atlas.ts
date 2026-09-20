import { Matrix4, Vector3 } from "three";
import { floatBuffer, type CapturePackage } from "./package";
import { importRoomPlan } from "./roomplan";
import {
  captureTriangles,
  visible,
  type Projector,
  type TexturedScan,
} from "./texture";

export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
export type PhotoDecoder = (
  name: string,
  thumbnail: boolean,
) => Promise<Pixels>;
type Triangle = {
  points: [Vector3, Vector3, Vector3];
  normal: Vector3;
  views: number[];
  structural: boolean;
  size: number;
  x: number;
  y: number;
  page: number;
};
const PAGE = 2048;
const MAX_PAGES = 4;
const MAX_TEXELS = 12_000_000;
const linear = Float32Array.from({ length: 256 }, (_, v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
const srgb = (v: number) =>
  Math.round(
    255 *
      Math.max(
        0,
        Math.min(
          1,
          v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055,
        ),
      ),
  );

/** Bilinear sampling in linear light. UVs follow the sensor's top-left origin. */
export function samplePhoto(
  photo: Pixels,
  u: number,
  v: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const x = Math.max(0, Math.min(photo.width - 1, u * photo.width - 0.5));
  const y = Math.max(0, Math.min(photo.height - 1, v * photo.height - 0.5));
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    dx = x - x0,
    dy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 2; col++) {
      const offset =
        (Math.min(y0 + row, photo.height - 1) * photo.width +
          Math.min(x0 + col, photo.width - 1)) *
        4;
      const weight = (col ? dx : 1 - dx) * (row ? dy : 1 - dy);
      for (let channel = 0; channel < 3; channel++)
        out[channel] += linear[photo.data[offset + channel]] * weight;
    }
  return out;
}

// Exposure is estimated only at the SAME measured points in overlapping views.
// A room-wide average would incorrectly brighten dark furniture or dim a white wall.
export function exposureGains(
  pairs: { a: number; b: number; ratio: number }[],
  count: number,
): number[] {
  const grouped = new Map<string, { a: number; b: number; values: number[] }>();
  for (const pair of pairs) {
    if (!Number.isFinite(pair.ratio) || pair.ratio <= 0) continue;
    const key = `${pair.a}/${pair.b}`;
    const group = grouped.get(key) ?? { a: pair.a, b: pair.b, values: [] };
    group.values.push(Math.log(pair.ratio));
    grouped.set(key, group);
  }
  const edges = [...grouped.values()]
    .filter((edge) => edge.values.length >= 6)
    .map((edge) => {
      edge.values.sort((a, b) => a - b);
      return {
        ...edge,
        delta: edge.values[Math.floor(edge.values.length / 2)],
      };
    });
  const gains = Array<number>(count).fill(0);
  for (let iteration = 0; iteration < 20; iteration++) {
    const sums = Array<number>(count).fill(0),
      weights = Array<number>(count).fill(0);
    for (const { a, b, delta } of edges) {
      sums[a] += gains[b] - delta;
      weights[a]++;
      sums[b] += gains[a] + delta;
      weights[b]++;
    }
    for (let i = 0; i < count; i++)
      if (weights[i])
        gains[i] = Math.max(
          -0.4,
          Math.min(0.4, (gains[i] + sums[i] / weights[i]) / 2),
        );
  }
  return gains.map(Math.exp);
}

function pack(triangles: Triangle[]): number {
  let x = 0,
    y = 0,
    row = 0,
    page = 0;
  for (const triangle of triangles) {
    if (!triangle.views.length) continue;
    if (x + triangle.size > PAGE) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + triangle.size > PAGE) {
      x = 0;
      y = 0;
      row = 0;
      page++;
    }
    Object.assign(triangle, { x, y, page });
    x += triangle.size;
    row = Math.max(row, triangle.size);
  }
  return page + 1;
}

/**
 * Bake projective, depth-tested photo blends into bounded texture atlases.
 * Full-resolution photos are decoded one at a time. At most one atlas accumulator
 * is resident; source photos and measured geometry are never rewritten.
 */
export async function blendCapture(
  capture: CapturePackage,
  decode: PhotoDecoder,
  encode: (pixels: Pixels) => Promise<Uint8Array>,
): Promise<TexturedScan> {
  const origin = importRoomPlan(capture.saved.original).capture.origin;
  const offset = new Vector3(origin.x, origin.y, origin.z);
  const projectors: Projector[] = capture.manifest.frames.map((frame) => ({
    frame,
    inverse: new Matrix4().fromArray(frame.cameraTransform).invert(),
    position: new Vector3().setFromMatrixPosition(
      new Matrix4().fromArray(frame.cameraTransform),
    ),
    depth: floatBuffer(capture.files[frame.depth]),
    confidence: capture.files[frame.confidence],
  }));
  const triangles: Triangle[] = [];
  let requested = 0;
  for (const { a, b, c, normal, structural } of captureTriangles(capture)) {
    const points: Triangle["points"] = [a, b, c];
    const center = points[0]
      .clone()
      .add(points[1])
      .add(points[2])
      .multiplyScalar(1 / 3);
    const choices: { index: number; score: number }[] = [];
    for (let index = 0; index < projectors.length; index++) {
      const projector = projectors[index];
      const direction = projector.position.clone().sub(center);
      const distance = direction.length();
      const facing = normal.dot(direction.normalize());
      const score = (facing * projector.frame.fx) / Math.max(0.1, distance);
      if (facing < 0.2 || (choices.length === 3 && score <= choices[2].score))
        continue;
      if (
        !visible(center, projector) ||
        !points.every((p) => visible(p, projector))
      )
        continue;
      choices.push({ index, score });
      choices.sort((a, b) => b.score - a.score || a.index - b.index);
      if (choices.length > 3) choices.pop();
    }
    const views = choices
      .slice(0, 3)
      .filter((choice) => choice.score >= choices[0].score * 0.35)
      .map((choice) => choice.index);
    const edge = Math.max(
      points[0].distanceTo(points[1]),
      points[0].distanceTo(points[2]),
      points[1].distanceTo(points[2]),
    );
    const size = views.length
      ? Math.min(
          1024,
          Math.max(4, 2 ** Math.ceil(Math.log2(edge * choices[0].score + 2))),
        )
      : 0;
    requested += size * size;
    triangles.push({
      points,
      normal,
      views,
      size,
      structural,
      x: 0,
      y: 0,
      page: -1,
    });
  }
  if (!triangles.length)
    throw new Error("The scan contains no usable surface triangles.");
  const scale = Math.min(1, Math.sqrt(MAX_TEXELS / Math.max(1, requested)));
  for (const t of triangles)
    if (t.size)
      t.size = Math.max(4, 2 ** Math.floor(Math.log2(t.size * scale)));
  triangles.sort((a, b) => b.size - a.size);
  let pages = pack(triangles);
  while (pages > MAX_PAGES) {
    for (const t of triangles) if (t.size > 4) t.size /= 2;
    pages = pack(triangles);
  }
  const thumbnails: Pixels[] = [];
  for (const p of projectors)
    thumbnails.push(await decode(p.frame.image, true));
  const pairs: Parameters<typeof exposureGains>[0] = [];
  for (
    let i = 0;
    i < triangles.length;
    i += Math.max(1, Math.ceil(triangles.length / 4000))
  ) {
    const t = triangles[i];
    if (t.views.length < 2) continue;
    const point = t.points[0]
      .clone()
      .add(t.points[1])
      .add(t.points[2])
      .multiplyScalar(1 / 3);
    const luma = t.views.map((index) => {
      const uv = visible(point, projectors[index]);
      if (!uv) return 0;
      const rgb = samplePhoto(thumbnails[index], uv.u, uv.v);
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    });
    for (let j = 1; j < t.views.length; j++)
      if (luma[0] > 0.02 && luma[0] < 0.8 && luma[j] > 0.02 && luma[j] < 0.8)
        pairs.push({ a: t.views[0], b: t.views[j], ratio: luma[0] / luma[j] });
  }
  const gains = exposureGains(pairs, projectors.length);
  const batches: TexturedScan["batches"] = [];
  const images: TexturedScan["images"] = [];
  const neutral: number[] = [];
  const point = new Vector3();
  const projection = { u: 0, v: 0, depth: 0 };
  const color: [number, number, number] = [0, 0, 0];
  let texturedFaceCount = 0;
  for (let page = 0; page < pages; page++) {
    const faces = triangles.filter((t) => t.page === page && t.views.length);
    if (!faces.length) continue;
    const width = Math.min(
      PAGE,
      faces.reduce((max, t) => Math.max(max, t.x + t.size), 0),
    );
    const height = Math.min(
      PAGE,
      faces.reduce((max, t) => Math.max(max, t.y + t.size), 0),
    );
    const accumulator = new Float32Array(width * height * 4);
    const used = new Set(faces.flatMap((t) => t.views));
    for (const index of used) {
      const projector = projectors[index];
      const photo = await decode(projector.frame.image, false);
      for (const triangle of faces) {
        if (!triangle.views.includes(index)) continue;
        const [a, b, c] = triangle.points;
        const inner = triangle.size - 3;
        for (let y = 0; y < triangle.size; y++)
          for (let x = 0; x < triangle.size; x++) {
            let u = Math.max(0, Math.min(1, (x - 1) / inner));
            let v = Math.max(0, Math.min(1, (y - 1) / inner));
            if (u + v > 1) {
              const sum = u + v;
              u /= sum;
              v /= sum;
            }
            point.set(
              a.x + (b.x - a.x) * u + (c.x - a.x) * v,
              a.y + (b.y - a.y) * u + (c.y - a.y) * v,
              a.z + (b.z - a.z) * u + (c.z - a.z) * v,
            );
            const uv = visible(point, projector, projection);
            if (!uv) continue;
            const dx = projector.position.x - point.x,
              dy = projector.position.y - point.y,
              dz = projector.position.z - point.z;
            const distance2 = dx * dx + dy * dy + dz * dz;
            const facing = Math.max(
              0,
              (triangle.normal.x * dx +
                triangle.normal.y * dy +
                triangle.normal.z * dz) /
                Math.sqrt(distance2),
            );
            const border = Math.min(
              1,
              Math.min(uv.u, uv.v, 1 - uv.u, 1 - uv.v) * 10,
            );
            const weight =
              (facing ** 2 * border ** 2 * projector.frame.fx ** 2) /
              Math.max(0.01, distance2);
            const rgb = samplePhoto(photo, uv.u, uv.v, color);
            const address = ((triangle.y + y) * width + triangle.x + x) * 4;
            for (let channel = 0; channel < 3; channel++)
              accumulator[address + channel] +=
                rgb[channel] * gains[index] * weight;
            accumulator[address + 3] += weight;
          }
      }
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      const weight = accumulator[i + 3];
      for (let channel = 0; channel < 3; channel++)
        data[i + channel] = weight
          ? srgb(accumulator[i + channel] / weight)
          : [183, 174, 161][channel];
      data[i + 3] = 255;
    }
    const name = `atlas-${page}.png`;
    images.push({
      name,
      bytes: await encode({ width, height, data }),
      width,
      height,
      atlas: true,
    });
    for (const structural of [false, true]) {
      const positions: number[] = [],
        uvs: number[] = [];
      for (const triangle of faces) {
        if (triangle.structural !== structural) continue;
        texturedFaceCount++;
        for (const p of triangle.points)
          positions.push(p.x - offset.x, p.y - offset.y, p.z - offset.z);
        const left = (triangle.x + 1.5) / width,
          top = (triangle.y + 1.5) / height;
        uvs.push(
          left,
          top,
          (triangle.x + triangle.size - 1.5) / width,
          top,
          left,
          (triangle.y + triangle.size - 1.5) / height,
        );
      }
      if (positions.length)
        batches.push({
          image: name,
          structural,
          positions: new Float32Array(positions),
          uvs: new Float32Array(uvs),
        });
    }
  }
  for (const structural of [false, true]) {
    neutral.length = 0;
    for (const triangle of triangles)
      if (!triangle.views.length && triangle.structural === structural)
        for (const p of triangle.points)
          neutral.push(p.x - offset.x, p.y - offset.y, p.z - offset.z);
    if (neutral.length)
      batches.push({
        image: null,
        structural,
        positions: new Float32Array(neutral),
        uvs: new Float32Array((neutral.length / 3) * 2),
      });
  }
  return {
    batches,
    images,
    faceCount: triangles.length,
    texturedFaceCount,
    warnings: capture.manifest.warnings,
  };
}
