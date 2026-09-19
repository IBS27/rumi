import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Edges,
  Html,
  Line,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import { DoubleSide, Matrix4, ShapeGeometry, Vector3 } from "three";
import type {
  CapturedRoom,
  CapturedSurface,
  RoomObject,
} from "../../../shared/contracts";
import { localCorners, worldCorners } from "../../../shared/capture/roomplan";
import { surfaceShape } from "../../../shared/capture/surfaces";

function Surface({
  value,
  openings,
}: {
  value: CapturedSurface;
  openings: CapturedSurface[];
}) {
  const geometry = useMemo(
    () => new ShapeGeometry(surfaceShape(value, openings)),
    [value, openings],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      matrix={new Matrix4().fromArray(value.transform)}
      matrixAutoUpdate={false}
      receiveShadow
    >
      <meshStandardMaterial
        color={value.kind === "floor" ? "#d2b898" : "#eee9de"}
        side={DoubleSide}
        roughness={0.95}
      />
      <Edges color={value.kind === "floor" ? "#ac9071" : "#c7c0b2"} />
    </mesh>
  );
}

function Furniture({
  object,
  selected,
  onSelect,
}: {
  object: RoomObject;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { width, height, depth } = object.dimensions;
  return (
    <group
      position={[object.position.x, object.position.y, object.position.z]}
      rotation={[object.rotation.x, object.rotation.y, object.rotation.z]}
    >
      <mesh
        position={[0, height / 2, 0]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(object.id);
        }}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
          color={selected ? "#567453" : object.color}
          roughness={0.85}
        />
        <Edges color={selected ? "#2e4a2b" : "#81776a"} />
      </mesh>
      {selected && (
        <Html
          position={[0, height + 0.2, 0]}
          center
          className="scene-label"
          style={{ pointerEvents: "none" }}
        >
          <span>{object.name}</span>
          <small>
            {width.toFixed(2)} × {depth.toFixed(2)} × {height.toFixed(2)} m
          </small>
        </Html>
      )}
    </group>
  );
}

function Cameras({ room, top }: { room: CapturedRoom; top: boolean }) {
  const { width, depth, height } = room.dimensions;
  const size = Math.max(width, depth, height);
  const viewport = useThree((state) => state.size);
  const zoom = Math.max(
    8,
    Math.min(viewport.width / (width + 2), viewport.height / (depth + 2)),
  );
  const center = new Vector3(width / 2, top ? 0 : height / 2, depth / 2);
  const verticalFov = (42 * Math.PI) / 180;
  const horizontalFov =
    2 *
    Math.atan((Math.tan(verticalFov / 2) * viewport.width) / viewport.height);
  const radius = Math.hypot(width, height, depth) / 2;
  const distance =
    (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.05;
  const position = top
    ? new Vector3(width / 2, size * 2, depth / 2)
    : new Vector3(0.95, 1.1, 1.15)
        .normalize()
        .multiplyScalar(distance)
        .add(center);
  return (
    <>
      {top ? (
        <OrthographicCamera
          makeDefault
          position={position}
          zoom={zoom}
          up={[0, 0, -1]}
          near={0.01}
          far={size * 30}
        />
      ) : (
        <PerspectiveCamera
          makeDefault
          position={position}
          fov={42}
          near={0.01}
          far={size * 30}
        />
      )}
      <OrbitControls
        key={`${room.id}-${top}`}
        makeDefault
        target={center}
        enableRotate={!top}
        minDistance={0.5}
        maxDistance={size * 6}
        maxPolarAngle={top ? Math.PI : Math.PI / 2.05}
      />
    </>
  );
}

class ViewerBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="viewer-fallback" role="alert">
        The 3D view could not start. Enable WebGL or try another browser. Your
        room measurements remain available in the object list.
      </div>
    ) : (
      this.props.children
    );
  }
}

export function RoomViewer({
  room,
  selected,
  onSelect,
  top,
  wallsVisible,
  dimensionsVisible,
}: {
  room: CapturedRoom;
  selected: string | null;
  onSelect: (id: string | null) => void;
  top: boolean;
  wallsVisible: boolean;
  dimensionsVisible: boolean;
}) {
  return (
    <ViewerBoundary key={room.id}>
      <Canvas
        shadows
        dpr={[1, 2]}
        onPointerMissed={() => onSelect(null)}
        aria-label="Interactive 3D room. Use the object list to select furniture with the keyboard."
        fallback={
          <div className="viewer-fallback">
            WebGL is unavailable. Room measurements are still available in the
            object list.
          </div>
        }
      >
        <color attach="background" args={["#f3f1eb"]} />
        <ambientLight intensity={1.5} />
        <directionalLight
          position={[3, 10, 5]}
          intensity={2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
        />
        <Suspense fallback={null}>
          <Cameras room={room} top={top} />
          {room.floors.map((floor) => (
            <Surface key={floor.id} value={floor} openings={[]} />
          ))}
          {wallsVisible &&
            room.walls.map((wall) => (
              <Surface key={wall.id} value={wall} openings={room.openings} />
            ))}
          {room.openings.map((opening) => {
            const points = worldCorners(opening);
            points.push(points[0]);
            return (
              <Line
                key={opening.id}
                points={points}
                color={opening.kind === "window" ? "#688a9b" : "#8e795f"}
                lineWidth={2}
              />
            );
          })}
          {room.objects.map((object) => (
            <Furniture
              key={object.id}
              object={object}
              selected={selected === object.id}
              onSelect={onSelect}
            />
          ))}
          {dimensionsVisible &&
            room.walls.map((wall) => {
              const point = new Vector3(
                0,
                -wall.dimensions.height / 2 + 0.03,
                0,
              ).applyMatrix4(new Matrix4().fromArray(wall.transform));
              const corners = localCorners(wall);
              return (
                <Html
                  key={wall.id}
                  center
                  position={point}
                  style={{ pointerEvents: "none" }}
                  className="wall-label"
                >
                  {(
                    Math.max(...corners.map((p) => p.x)) -
                    Math.min(...corners.map((p) => p.x))
                  ).toFixed(2)}{" "}
                  m
                </Html>
              );
            })}
        </Suspense>
      </Canvas>
    </ViewerBoundary>
  );
}
