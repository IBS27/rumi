import { useLayoutEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { DirectionalLight, Object3D } from "three";
import type { CapturedRoom } from "../../../../shared/contracts";
import type { ReconstructedScene } from "../../../../shared/reconstruction/contracts";

export function SceneLighting({
  room,
  inside,
  scene,
  walls,
  cutaway,
}: {
  room: CapturedRoom;
  inside: boolean;
  scene: ReconstructedScene;
  walls: boolean;
  cutaway: boolean;
}) {
  const light = useRef<DirectionalLight>(null);
  const invalidate = useThree((state) => state.invalidate);
  const { width, depth, height } = room.dimensions;
  const target = useMemo(() => {
    const object = new Object3D();
    object.position.set(width / 2, 0, depth / 2);
    return object;
  }, [width, depth]);
  const window = room.openings.find((opening) => opening.kind === "window");
  const position: [number, number, number] = window
    ? [window.transform[12], height + 5, window.transform[14]]
    : [width / 2 - 3, height + 5, depth / 2 + 4];
  const extent = Math.hypot(width, depth) / 2 + 0.5;
  useLayoutEffect(() => {
    if (light.current) light.current.shadow.needsUpdate = true;
    invalidate();
  }, [room, scene, walls, cutaway, inside, invalidate]);
  return (
    <>
      <ambientLight intensity={0.2} />
      <hemisphereLight args={["#f7f6f2", "#e9e2d6", inside ? 0.85 : 0.65]} />
      <primitive object={target} />
      <directionalLight
        ref={light}
        target={target}
        position={position}
        intensity={2.5}
        castShadow
        shadow-autoUpdate={false}
        shadow-bias={-0.0001}
      shadow-normalBias={0.008}
      shadow-radius={4}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.1}
        shadow-camera-far={height + Math.hypot(width, depth) + 15}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
      />
    </>
  );
}
