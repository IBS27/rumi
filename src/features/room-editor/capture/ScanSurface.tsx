import { useEffect, useState, type ReactNode } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  MeshBasicMaterial,
  LinearFilter,
  MeshStandardMaterial,
  SRGBColorSpace,
  Texture,
} from "three";
import type { TexturedScan } from "../../../../shared/capture/texture";

type Resources = {
  scan: TexturedScan;
  items: {
    geometry: BufferGeometry;
    material: MeshBasicMaterial | MeshStandardMaterial;
    structural: boolean;
  }[];
};
export function ScanSurface({
  scan,
  wallsVisible,
  onError,
  fallback,
}: {
  scan: TexturedScan;
  wallsVisible: boolean;
  onError: (message: string) => void;
  fallback: ReactNode;
}) {
  const [resources, setResources] = useState<Resources | null>(null);
  useEffect(() => {
    let canceled = false;
    const textures = new Map<string, Texture>();
    const bitmaps: ImageBitmap[] = [];
    const items: Resources["items"] = [];
    async function prepare() {
      try {
        // Decode atlases sequentially to bound transient image memory.
        for (const image of scan.images) {
          const bitmap = await createImageBitmap(
            new Blob([image.bytes.slice().buffer], {
              type: image.atlas ? "image/png" : "image/jpeg",
            }),
          );
          if (canceled) {
            bitmap.close();
            return;
          }
          if (bitmap.width !== image.width || bitmap.height !== image.height) {
            bitmap.close();
            throw new Error(
              "A scan photo does not match its camera calibration.",
            );
          }
          bitmaps.push(bitmap);
          const texture = new Texture(bitmap);
          texture.flipY = false;
          texture.colorSpace = SRGBColorSpace;
          // Atlas islands have a one-pixel gutter. Mipmaps would mix neighboring islands.
          if (image.atlas) {
            texture.generateMipmaps = false;
            texture.minFilter = LinearFilter;
          }
          texture.needsUpdate = true;
          textures.set(image.name, texture);
        }
        if (canceled) return;
        for (const batch of scan.batches) {
          const geometry = new BufferGeometry();
          geometry.setAttribute(
            "position",
            new BufferAttribute(batch.positions, 3),
          );
          geometry.setAttribute("uv", new BufferAttribute(batch.uvs, 2));
          geometry.computeBoundingSphere();
          // Photos already include scene lighting. Do not light them a second time.
          if (!batch.image) geometry.computeVertexNormals();
          const material = batch.image
            ? new MeshBasicMaterial({
                map: textures.get(batch.image),
                side: DoubleSide,
                toneMapped: false,
              })
            : new MeshStandardMaterial({
                color: "#b7aea1",
                side: DoubleSide,
                roughness: 0.9,
              });
          items.push({ geometry, material, structural: batch.structural });
        }
        setResources({ scan, items });
      } catch (error) {
        if (!canceled)
          onError(
            error instanceof Error
              ? error.message
              : "Could not display scan photos.",
          );
      }
    }
    void prepare();
    return () => {
      canceled = true;
      items.forEach(({ geometry, material }) => {
        geometry.dispose();
        material.dispose();
      });
      textures.forEach((texture) => texture.dispose());
      bitmaps.forEach((bitmap) => bitmap.close());
    };
  }, [scan, onError]);
  if (resources?.scan !== scan) return fallback;
  return resources.items.map((item, index) => (
    <mesh
      key={index}
      geometry={item.geometry}
      material={item.material}
      visible={wallsVisible || !item.structural}
      dispose={null}
    />
  ));
}
