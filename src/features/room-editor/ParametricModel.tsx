import type { ThreeElements } from "@react-three/fiber";
import type { ParametricModel as ParametricModelData } from "../../../shared/assets/model";
import type { Dimensions } from "../../../shared/contracts";

const MATERIALS: Record<
  ParametricModelData["parts"][number]["material"],
  ThreeElements["meshStandardMaterial"]
> = {
  matte: { roughness: 0.82, metalness: 0 },
  wood: { roughness: 0.68, metalness: 0 },
  metal: { roughness: 0.28, metalness: 0.72 },
  glass: { roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32 },
  fabric: { roughness: 1, metalness: 0 },
};

export interface ParametricModelProps {
  model: ParametricModelData;
  dimensions?: Dimensions;
}

export function ParametricModel({ model, dimensions }: ParametricModelProps) {
  const { width, height, depth } = dimensions ?? model.dimensions;
  return (
    <group name={model.label}>
      {model.parts.map((part) => {
        const size: [number, number, number] = [
          part.size.x * width,
          part.size.y * height,
          part.size.z * depth,
        ];
        const position: [number, number, number] = [
          part.position.x * width,
          part.position.y * height,
          part.position.z * depth,
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
            {part.shape === "box" && <boxGeometry args={size} />}
            {part.shape === "cylinder" && (
              <cylinderGeometry args={[0.5, 0.5, 1, 24]} />
            )}
            {part.shape === "sphere" && <sphereGeometry args={[0.5, 24, 16]} />}
            <meshStandardMaterial
              color={part.color}
              {...MATERIALS[part.material]}
            />
          </mesh>
        );
      })}
    </group>
  );
}
