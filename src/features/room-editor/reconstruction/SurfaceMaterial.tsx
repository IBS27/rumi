import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { Environment } from "@react-three/drei";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  DataTexture,
  RepeatWrapping,
  LinearMipmapLinearFilter,
  type Side,
} from "three";
import type { MaterialDetail } from "../../../../shared/assets/materials";
import {
  DEFAULT_DETAILS,
  materialPixels,
  type MaterialKind,
} from "./materials";

const TextureCache = createContext<Map<string, DataTexture> | null>(null);

export function MaterialResources({ children }: { children: ReactNode }) {
  const textures = useMemo(() => new Map<string, DataTexture>(), []);
  useEffect(() => {
    for (const texture of textures.values()) texture.needsUpdate = true;
    return () => {
      for (const texture of textures.values()) texture.dispose();
    };
  }, [textures]);
  return (
    <TextureCache.Provider value={textures}>{children}</TextureCache.Provider>
  );
}

// A local, neutral reflection environment gives chrome/varnish something to
// reflect. No remote HDR asset or photographed room backdrop is involved.
export function MaterialEnvironment() {
  const room = useMemo(() => new RoomEnvironment(), []);
  useEffect(() => () => room.dispose(), [room]);
  return (
    <Environment resolution={64} frames={1} environmentIntensity={0.5}>
      <primitive object={room} />
    </Environment>
  );
}

export function SurfaceMaterial({
  color,
  material,
  detail,
  side,
  transparent = false,
  depthOffset = 0,
}: {
  color: string;
  material: MaterialKind;
  detail?: MaterialDetail | null;
  side?: Side;
  // Glass-like opaque screens and glazed furniture must not become see-through.
  transparent?: boolean;
  depthOffset?: number;
}) {
  const textures = useContext(TextureCache);
  const {
    texture: pattern,
    repeatWidth,
    repeatHeight,
    roughness,
  } = detail ?? DEFAULT_DETAILS[material];
  const texture = useMemo(() => {
    if (pattern === "plain") return null;
    const key = `${pattern}:${repeatWidth}:${repeatHeight}`;
    const cached = textures?.get(key);
    if (cached) return cached;
    const value = new DataTexture(
      materialPixels({
        texture: pattern,
        repeatWidth,
        repeatHeight,
        roughness: 1,
      }),
      256,
      256,
    );
    value.wrapS = value.wrapT = RepeatWrapping;
    value.repeat.set(1 / repeatWidth, 1 / repeatHeight);
    value.generateMipmaps = true;
    value.minFilter = LinearMipmapLinearFilter;
    value.anisotropy = 4;
    value.needsUpdate = true;
    textures?.set(key, value);
    return value;
  }, [pattern, repeatWidth, repeatHeight, textures]);
  useEffect(
    () => () => {
      if (!textures) texture?.dispose();
    },
    [texture, textures],
  );
  return (
    <meshStandardMaterial
      color={color}
      // Microstructure must not darken the measured paint/cloth color. Keep
      // albedo variation only for materials with an actual visible pattern.
      map={
        pattern === "woodgrain" || pattern === "tile" || pattern === "stone"
          ? texture
          : null
      }
      bumpMap={texture}
      bumpScale={
        pattern === "carpet"
          ? 0.012
          : pattern === "tile"
            ? 0.003
            : pattern === "weave"
              ? 0.004
              : 0.001
      }
      roughness={roughness}
      metalness={material === "metal" ? 0.72 : 0}
      polygonOffset={depthOffset > 0}
      polygonOffsetFactor={-depthOffset}
      polygonOffsetUnits={-depthOffset}
      depthWrite={!transparent}
      transparent={transparent}
      opacity={transparent ? 0.22 : 1}
      side={side}
    />
  );
}
