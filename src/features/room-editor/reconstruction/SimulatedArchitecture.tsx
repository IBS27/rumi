import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  DoubleSide,
  FrontSide,
  BackSide,
  Matrix4,
  ShapeGeometry,
  Group,
  DirectionalLight,
} from "three";
import type {
  CapturedRoom,
  CapturedSurface,
} from "../../../../shared/contracts";
import type {
  ReconstructedScene,
  SurfaceFinish,
} from "../../../../shared/reconstruction/contracts";
import { surfaceShape } from "../../../../shared/capture/surfaces";
import { surfaceGeometry } from "../surfaceGeometry";
import { finishRegionShapes } from "../../../../shared/reconstruction/surfaces";
import { SurfaceMaterial } from "./SurfaceMaterial";
import { applyMeterUVs } from "./materials";
import {
  exteriorNormal,
  lowerWall,
  shouldLowerWall,
} from "../../../../shared/reconstruction/architecture";

function SolidSurface({
  surface,
  openings,
  finish,
  finishes,
  showOpenings = true,
}: {
  surface: CapturedSurface;
  openings: CapturedSurface[];
  finish?: SurfaceFinish;
  finishes?: ReadonlyMap<string, SurfaceFinish>;
  showOpenings?: boolean;
}) {
  const wall = surface.kind === "wall";
  const geometry = useMemo(
    () => surfaceGeometry(surface, openings),
    [surface, openings],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group>
      <mesh
        geometry={geometry}
        matrix={new Matrix4().fromArray(surface.transform)}
        matrixAutoUpdate={false}
        castShadow={wall}
        receiveShadow
      >
        <SurfaceMaterial
          color={finish?.color ?? (wall ? "#f1ece2" : "#d9cfbc")}
          side={DoubleSide}
          material={finish?.material ?? "matte"}
          detail={finish?.detail}
        />
      </mesh>
      {finish?.regions?.map((region, index) => (
        <FinishRegion
          key={index}
          surface={surface}
          openings={openings}
          region={region}
          order={index}
        />
      ))}
      {wall &&
        showOpenings &&
        openings
          .filter((o) => o.parentId === surface.id)
          .map((value) => (
            <Opening
              key={value.id}
              value={value}
              finish={finishes?.get(value.id)}
            />
          ))}
    </group>
  );
}

function OverviewWall({
  surface,
  room,
  finish,
  finishes,
  cutaway,
}: {
  surface: CapturedSurface;
  room: CapturedRoom;
  finish?: SurfaceFinish;
  finishes: ReadonlyMap<string, SurfaceFinish>;
  cutaway: boolean;
}) {
  const full = useRef<Group>(null),
    low = useRef<Group>(null);
  const outward = useMemo(
    () => exteriorNormal(surface, room.floors),
    [surface, room.floors],
  );
  const shortened = useMemo(() => lowerWall(surface), [surface]);
  useFrame(({ camera, scene }) => {
    if (!full.current || !low.current) return;
    const facing =
      outward &&
      outward.x * (camera.position.x - surface.transform[12]) +
        outward.z * (camera.position.z - surface.transform[14]);
    const lower =
      cutaway &&
      facing !== null &&
      shouldLowerWall(facing, low.current.visible);
    if (full.current.visible !== !lower) {
      full.current.visible = !lower;
      low.current.visible = lower;
      scene.traverse((object) => {
        if (object instanceof DirectionalLight)
          object.shadow.needsUpdate = true;
      });
    }
  });
  return (
    <>
      <group ref={full}>
        <SolidSurface
          surface={surface}
          openings={room.openings}
          finish={finish}
          finishes={finishes}
        />
      </group>
      {outward && (
        <group ref={low} visible={false}>
          <SolidSurface
            surface={shortened}
            openings={room.openings}
            finish={finish}
            showOpenings={false}
          />
        </group>
      )}
    </>
  );
}

function FinishRegion({
  surface,
  openings,
  region,
  order,
}: {
  surface: CapturedSurface;
  openings: CapturedSurface[];
  region: NonNullable<SurfaceFinish["regions"]>[number];
  order: number;
}) {
  const geometry = useMemo(
    () =>
      new ShapeGeometry(finishRegionShapes(surface, openings, region.polygon)),
    [surface, openings, region],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const wall = surface.kind === "wall";
  const offset =
    (wall ? Math.max(0.08, Math.min(0.2, surface.dimensions.depth)) / 2 : 0) +
    0.001 +
    order * 0.0001;
  const faces =
    region.side === "both" ? [1, -1] : [region.side === "front" ? 1 : -1];
  return (
    <group
      matrix={new Matrix4().fromArray(surface.transform)}
      matrixAutoUpdate={false}
    >
      {faces.map((sign) => (
        <mesh
          key={sign}
          geometry={geometry}
          position={[0, 0, sign * offset]}
          receiveShadow
        >
          <SurfaceMaterial
            color={region.color ?? "#e5e1d8"}
            material={region.material}
            detail={region.detail}
            side={sign === 1 ? FrontSide : BackSide}
            depthOffset={order + 1}
          />
        </mesh>
      ))}
    </group>
  );
}

function Opening({
  value,
  finish,
}: {
  value: CapturedSurface;
  finish?: SurfaceFinish;
}) {
  if (value.kind === "opening") return null;
  const { width, height } = value.dimensions;
  const border = Math.min(0.055, width / 10, height / 10);
  const frameColor =
    finish?.color ?? (value.kind === "window" ? "#f7f6f2" : "#d9cfbc");
  return (
    <group
      matrix={new Matrix4().fromArray(value.transform)}
      matrixAutoUpdate={false}
    >
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          position={[(sign * (width - border)) / 2, 0, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[border, height, 0.1]} />
          <meshStandardMaterial color={frameColor} roughness={0.65} />
        </mesh>
      ))}
      <mesh position={[0, (height - border) / 2, 0]} castShadow>
        <boxGeometry args={[width, border, 0.1]} />
        <meshStandardMaterial color={frameColor} />
      </mesh>
      {value.kind === "window" ? (
        <>
          <mesh position={[0, -(height - border) / 2, 0]} castShadow>
            <boxGeometry args={[width, border, 0.1]} />
            <meshStandardMaterial color={frameColor} />
          </mesh>
          <mesh>
            <planeGeometry args={[width - border * 2, height - border * 2]} />
            <meshStandardMaterial
              color="#edf2f4"
              transparent
              depthWrite={false}
              opacity={0.22}
              roughness={0.12}
              side={DoubleSide}
            />
          </mesh>
        </>
      ) : (
        <group
          position={[-width / 2 + border, 0, 0]}
          rotation={[0, Math.PI / 2, 0]}
        >
          <mesh
            position={[(width - border * 2) / 2, 0, 0]}
            castShadow
            receiveShadow
          >
            <boxGeometry
              args={[width - border * 2, height - border, 0.035]}
              onUpdate={(geometry) => applyMeterUVs(geometry, [1, 1, 1], "box")}
            />
            <SurfaceMaterial
              color={frameColor}
              material={finish?.material ?? "wood"}
              detail={finish?.detail}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

function Ceiling({
  floor,
  height,
}: {
  floor: CapturedSurface;
  height: number;
}) {
  const geometry = useMemo(
    () => new ShapeGeometry(surfaceShape(floor)),
    [floor],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const matrix = useMemo(() => {
    const value = new Matrix4().fromArray(floor.transform);
    value.elements[13] += height;
    return value;
  }, [floor, height]);
  return (
    <mesh
      geometry={geometry}
      matrix={matrix}
      matrixAutoUpdate={false}
      receiveShadow
    >
      <meshStandardMaterial
        color="#f7f6f2"
        side={DoubleSide}
        roughness={0.95}
      />
    </mesh>
  );
}

export function SimulatedArchitecture({
  room,
  scene,
  walls,
  inside,
  cutaway = false,
}: {
  room: CapturedRoom;
  scene: ReconstructedScene;
  walls: boolean;
  inside: boolean;
  cutaway?: boolean;
}) {
  const finishes = useMemo(
    () => new Map(scene.surfaces.map((s) => [s.surfaceId, s])),
    [scene],
  );
  return (
    <>
      {inside &&
        room.floors.map((floor) => (
          <Ceiling
            key={`ceiling-${floor.id}`}
            floor={floor}
            height={room.dimensions.height}
          />
        ))}
      {room.floors.map((surface) => (
        <SolidSurface
          key={surface.id}
          surface={surface}
          openings={room.openings}
          finish={finishes.get(surface.id)}
        />
      ))}
      {walls &&
        room.walls.map((surface) => (
          <OverviewWall
            key={surface.id}
            surface={surface}
            room={room}
            finish={finishes.get(surface.id)}
            finishes={finishes}
            cutaway={cutaway && !inside}
          />
        ))}
      {walls &&
        room.openings
          .filter((value) => !value.parentId)
          .map((value) => (
            <Opening
              key={value.id}
              value={value}
              finish={finishes.get(value.id)}
            />
          ))}
    </>
  );
}
