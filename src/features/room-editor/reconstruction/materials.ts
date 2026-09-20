import {
  BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
} from "three";
import type { MaterialDetail } from "../../../../shared/assets/materials";
import type { ParametricModel } from "../../../../shared/assets/model";

export type MaterialKind = ParametricModel["parts"][number]["material"];
export const DEFAULT_DETAILS: Record<MaterialKind, MaterialDetail> = {
  matte: { texture: "plain", repeatWidth: 1, repeatHeight: 1, roughness: 0.82 },
  wood: {
    texture: "woodgrain",
    repeatWidth: 0.24,
    repeatHeight: 1.2,
    roughness: 0.55,
  },
  fabric: {
    texture: "weave",
    repeatWidth: 0.025,
    repeatHeight: 0.025,
    roughness: 0.95,
  },
  metal: { texture: "plain", repeatWidth: 1, repeatHeight: 1, roughness: 0.25 },
  glass: { texture: "plain", repeatWidth: 1, repeatHeight: 1, roughness: 0.08 },
};

// Periodic, deterministic patterns. They supply only small neutral variations;
// the photo-derived material color remains the base color. No capture image is mapped.
export function materialPixels(detail: MaterialDetail, resolution = 256) {
  const pixels = new Uint8Array(resolution * resolution * 4);
  const tau = Math.PI * 2;
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const u = x / resolution,
        v = y / resolution;
      const noise =
        ((Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263)) >>> 0) /
        4294967295;
      let value = 1;
      switch (detail.texture) {
        case "woodgrain": {
          const bend = 0.7 * Math.sin(v * tau) + 0.25 * Math.sin(v * tau * 3);
          const grain = (Math.sin(u * tau * 28 + bend) + 1) / 2;
          value = 0.88 + 0.085 * grain + 0.035 * noise;
          break;
        }
        case "weave":
          value =
            0.9 +
            0.05 * Math.cos(u * tau * 8) * Math.cos(v * tau * 8) +
            0.05 * noise;
          break;
        case "carpet":
          value = 0.82 + 0.12 * noise + 0.06 * Math.sin(u * tau * 16) ** 2;
          break;
        case "plaster":
          value = 0.975 + 0.025 * noise;
          break;
        case "stone":
          value =
            0.95 +
            0.03 * Math.sin(u * tau * 3 + Math.sin(v * tau * 2)) +
            0.02 * noise;
          break;
        case "tile": {
          const edge =
            Math.min(u, 1 - u) * detail.repeatWidth < 0.0015 ||
            Math.min(v, 1 - v) * detail.repeatHeight < 0.0015;
          value = edge ? 0.64 : 0.98 + 0.02 * noise;
          break;
        }
      }
      const index = (y * resolution + x) * 4;
      pixels[index] =
        pixels[index + 1] =
        pixels[index + 2] =
          Math.round(255 * value);
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

// Each face uses physical meters so grain/weave does not stretch to fit a whole
// sofa, tiny leg, or floor. Rounded boxes use their dominant face for continuity.
const originalUVs = new WeakMap<
  BufferGeometry,
  BufferAttribute | InterleavedBufferAttribute
>();
export function applyMeterUVs(
  geometry: BufferGeometry,
  scale: readonly [number, number, number],
  shape: "box" | "cylinder" | "sphere",
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  let source = originalUVs.get(geometry);
  if (!source) {
    source = geometry.getAttribute("uv").clone();
    originalUVs.set(geometry, source);
  }
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    if (shape !== "box") {
      uv[i * 2] = (source.getX(i) * Math.PI * (scale[0] + scale[2])) / 2;
      uv[i * 2 + 1] =
        source.getY(i) * scale[1] * (shape === "sphere" ? Math.PI / 2 : 1);
      continue;
    }
    const x = Math.abs(normal.getX(i)),
      y = Math.abs(normal.getY(i)),
      z = Math.abs(normal.getZ(i));
    uv[i * 2] =
      x > y && x > z
        ? position.getZ(i) * scale[2]
        : position.getX(i) * scale[0];
    uv[i * 2 + 1] =
      y > x && y > z
        ? position.getZ(i) * scale[2]
        : position.getY(i) * scale[1];
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}
