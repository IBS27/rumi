import { describe, expect, test } from "bun:test";
import {
  blendCapture,
  exposureGains,
  samplePhoto,
  type Pixels,
} from "../shared/capture/texture-atlas";
import { readPackage } from "../shared/capture/package";
import { syntheticCaptureZip } from "./fixtures/capture-package";

function photo(rgb: (x: number, y: number) => number[]): Pixels {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      data.set([...rgb(x, y), 255], (y * 64 + x) * 4);
  return { width: 64, height: 64, data };
}
async function bake(
  capture = readPackage(syntheticCaptureZip()),
  photos = new Map([["photo.jpg", photo((x, y) => [x * 4, y * 4, 0])]]),
) {
  const atlases = new Map<string, Pixels>();
  let i = 0;
  const scan = await blendCapture(
    capture,
    async (name) => {
      const p = photos.get(name);
      if (!p) throw new Error(`Missing photo ${name}`);
      return p;
    },
    async (pixels) => {
      atlases.set(`atlas-${i++}.png`, pixels);
      return new Uint8Array([1]);
    },
  );
  return { scan, atlases };
}
function vertexColor(result: Awaited<ReturnType<typeof bake>>, vertex: number) {
  const batch = result.scan.batches.find((b) => b.image)!;
  const image = result.atlases.get(batch.image!)!;
  const x = Math.floor(batch.uvs[vertex * 2] * image.width);
  const y = Math.floor(batch.uvs[vertex * 2 + 1] * image.height);
  return [
    ...image.data.slice(
      (y * image.width + x) * 4,
      (y * image.width + x) * 4 + 3,
    ),
  ];
}
describe("photo texture atlases", () => {
  test("preserves sensor orientation and the measured positions", async () => {
    const result = await bake();
    expect(result.scan.texturedFaceCount).toBe(1);
    expect([...result.scan.batches[0].positions]).toEqual([
      1, 0, 2, 3, 0, 2, 2, 2, 2,
    ]);
    const a = vertexColor(result, 0),
      b = vertexColor(result, 1),
      c = vertexColor(result, 2);
    expect(a[0]).toBeCloseTo(62, 0);
    expect(b[0]).toBeCloseTo(190, 0);
    expect(a[1]).toBeCloseTo(190, 0);
    expect(c[1]).toBeCloseTo(62, 0);
    expect(result.scan.images[0].atlas).toBe(true);
  });
  test("blends overlapping photos in linear light and excludes an occluded view", async () => {
    const capture = readPackage(syntheticCaptureZip());
    const first = capture.manifest.frames[0];
    capture.manifest.frames.push(
      { ...first, image: "blue.jpg" },
      { ...first, image: "blocked.jpg", depth: "blocked.bin" },
    );
    capture.files["blue.jpg"] = capture.files["photo.jpg"];
    capture.files["blocked.jpg"] = capture.files["photo.jpg"];
    capture.files["blocked.bin"] = new Uint8Array(
      new Float32Array(64).fill(1).buffer,
    );
    const result = await bake(
      capture,
      new Map([
        ["photo.jpg", photo(() => [255, 0, 0])],
        ["blue.jpg", photo(() => [0, 0, 255])],
        ["blocked.jpg", photo(() => [0, 255, 0])],
      ]),
    );
    const rgb = vertexColor(result, 0);
    expect(rgb[0]).toBeCloseTo(188, 0);
    expect(rgb[1]).toBe(0);
    expect(rgb[2]).toBeCloseTo(188, 0);
  });
  test("unknown depth never gets a guessed texture", async () => {
    const capture = readPackage(syntheticCaptureZip());
    capture.files["confidence.bin"].fill(0);
    const result = await bake(capture);
    expect(result.scan.texturedFaceCount).toBe(0);
    expect(result.scan.images).toEqual([]);
    expect(result.scan.batches[0].image).toBeNull();
  });
  test("does not smear a foreground photo through a triangle's interior", async () => {
    const capture = readPackage(syntheticCaptureZip());
    // This off-center pixel is not one of the triangle's four initial visibility probes.
    const depths = new Float32Array(64).fill(2);
    depths[3 * 8 + 3] = 1;
    capture.files["depth.bin"] = new Uint8Array(depths.buffer);
    const result = await bake(
      capture,
      new Map([["photo.jpg", photo(() => [255, 0, 0])]]),
    );
    const image = [...result.atlases.values()][0];
    expect(image).toBeDefined();
    let neutral = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i] === 183 && image.data[i + 1] === 174) neutral++;
    expect(neutral).toBeGreaterThan(0);
  });
  test("exposure matching uses robust overlap ratios and preserves unmatched views", () => {
    const pairs = Array.from({ length: 20 }, () => ({ a: 0, b: 1, ratio: 2 }));
    pairs.push({ a: 0, b: 1, ratio: 100 });
    const gains = exposureGains(pairs, 3);
    expect(gains[1] / gains[0]).toBeCloseTo(2, 3);
    expect(gains[2]).toBe(1);
    expect(exposureGains(pairs.slice(0, 2), 2)).toEqual([1, 1]);
  });
  test("bilinear filtering averages light, with bounded image-edge sampling", () => {
    const pixels = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    };
    expect(samplePhoto(pixels, 0.5, 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(samplePhoto(pixels, -1, -1)).toEqual([0, 0, 0]);
    expect(samplePhoto(pixels, 2, 2)).toEqual([1, 1, 1]);
  });
});

test("projects tilted surfaces per pixel instead of interpolating photo UVs", async () => {
  const capture = readPackage(syntheticCaptureZip());
  // Plane z = x - 1. Its vertices have different camera-axis depths.
  capture.files["mesh.bin"] = new Uint8Array(
    new Float32Array([1, 0, 0, 3, 0, 2, 2, 2, 1]).buffer,
  );
  const frame = capture.manifest.frames[0];
  frame.depthWidth = frame.depthHeight = 256;
  const depths = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const rayX = (((x + 0.5) / 256) * frame.width - frame.cx) / frame.fx;
      depths[y * 256 + x] = 3 / (1 + rayX);
    }
  capture.files["depth.bin"] = new Uint8Array(depths.buffer);
  capture.files["confidence.bin"] = new Uint8Array(256 * 256).fill(2);
  const result = await bake(capture);
  const batch = result.scan.batches[0];
  expect(batch.image).not.toBeNull();
  const atlas = result.atlases.get(batch.image!)!;
  // Midpoint of edge AB is world (2,0,1), projecting to u=.5, v=2/3.
  const u = (batch.uvs[0] + batch.uvs[2]) / 2;
  const v = (batch.uvs[1] + batch.uvs[3]) / 2;
  const rgb = samplePhoto(atlas, u, v);
  const expected = samplePhoto(
    photo((x, y) => [x * 4, y * 4, 0]),
    0.5,
    2 / 3,
  );
  expect(rgb[0]).toBeCloseTo(expected[0], 2);
  expect(rgb[1]).toBeCloseTo(expected[1], 2);
  expect([...batch.positions]).toEqual([1, 0, 0, 3, 0, 2, 2, 2, 1]);
});
