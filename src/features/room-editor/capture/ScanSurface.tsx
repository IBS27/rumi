import { useEffect, useState } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  MeshBasicMaterial,
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
}: {
  scan: TexturedScan;
  wallsVisible: boolean;
  onError: (message: string) => void;
}) {
  const [resources, setResources] = useState<Resources | null>(null);
  useEffect(() => {
    let canceled = false;
    const textures = new Map<string, Texture>();
    const bitmaps: ImageBitmap[] = [];
    const items: Resources["items"] = [];
    async function prepare() {
      try {
        // Sequential decode bounds transient image memory and avoids a 96-image burst.
        for (const image of scan.images) {
          const bitmap = await createImageBitmap(
            new Blob([image.bytes.slice().buffer], { type: "image/jpeg" }),
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
  if (resources?.scan !== scan) return null;
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
