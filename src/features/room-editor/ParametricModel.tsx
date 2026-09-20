import type { ReconstructedObject } from "../../../shared/reconstruction/contracts";
import type { ParametricModel as ParametricModelData } from "../../../shared/assets/model";
import type { Dimensions } from "../../../shared/contracts";
import { useEffect, useMemo } from "react";
import { roundedPartGeometry } from "./reconstruction/geometry";

import { SurfaceMaterial } from "./reconstruction/SurfaceMaterial";
import { applyMeterUVs } from "./reconstruction/materials";

function SoftEdgeGeometry({
  size,
  meters,
  fabric,
}: {
  size: [number, number, number];
  meters: [number, number, number];
  fabric: boolean;
}) {
  const [x, y, z] = size;
  const [mx, my, mz] = meters;
  const geometry = useMemo(() => {
    return roundedPartGeometry([x, y, z], [mx, my, mz], fabric);
  }, [x, y, z, mx, my, mz, fabric]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <primitive object={geometry} attach="geometry" />;
}

export interface ParametricModelProps {
  model: Pick<ParametricModelData, "label" | "parts" | "dimensions"> &
    Pick<ReconstructedObject, "renderBounds">;
  dimensions?: Dimensions;
}

export function ParametricModel({ model, dimensions }: ParametricModelProps) {
  const { width, height, depth } = dimensions ?? model.dimensions;
  const bounds = model.renderBounds;
  return (
    <group name={model.label} scale={[width, height, depth]}>
      <group
        scale={
          bounds ? [bounds.scale.x, bounds.scale.y, bounds.scale.z] : undefined
        }
        position={
          bounds
            ? [bounds.offset.x, bounds.offset.y, bounds.offset.z]
            : undefined
        }
      >
        {model.parts.map((part) => {
          const size: [number, number, number] = [
            part.size.x,
            part.size.y,
            part.size.z,
          ];
          const position: [number, number, number] = [
            part.position.x,
            part.position.y,
            part.position.z,
          ];
          const rotation: [number, number, number] = [
            part.rotation.x,
            part.rotation.y,
            part.rotation.z,
          ];
          return (
            <mesh
              key={part.id}
              name={part.name}
              position={position}
              rotation={rotation}
              scale={part.shape === "box" ? undefined : size}
              castShadow
              receiveShadow
            >
              {part.shape === "box" && (
                <SoftEdgeGeometry
                  size={size}
                  meters={[
                    width * (bounds?.scale.x ?? 1),
                    height * (bounds?.scale.y ?? 1),
                    depth * (bounds?.scale.z ?? 1),
                  ]}
                  fabric={part.material === "fabric"}
                />
              )}
              {part.shape === "cylinder" && (
                <cylinderGeometry
                  args={[0.5, 0.5, 1, 24]}
                  onUpdate={(geometry) =>
                    applyMeterUVs(
                      geometry,
                      [
                        width * size[0] * (bounds?.scale.x ?? 1),
                        height * size[1] * (bounds?.scale.y ?? 1),
                        depth * size[2] * (bounds?.scale.z ?? 1),
                      ],
                      "cylinder",
                    )
                  }
                />
              )}
              {part.shape === "sphere" && (
                <sphereGeometry
                  args={[0.5, 24, 16]}
                  onUpdate={(geometry) =>
                    applyMeterUVs(
                      geometry,
                      [
                        width * size[0] * (bounds?.scale.x ?? 1),
                        height * size[1] * (bounds?.scale.y ?? 1),
                        depth * size[2] * (bounds?.scale.z ?? 1),
                      ],
                      "sphere",
                    )
                  }
                />
              )}
              <SurfaceMaterial
                color={part.color}
                material={part.material}
                detail={part.detail}
                transparent={
                  part.material === "glass" &&
                  !/screen|display/i.test(part.name)
                }
              />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}
