import { clearFurnitureSurfaces } from "../../../shared/reconstruction/cleanup";
import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Edges,
  Html,
  Line,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
  TransformControls,
} from "@react-three/drei";
import { DoubleSide, Matrix4, Vector3, PCFShadowMap, Group } from "three";
import type {
  CapturedRoom,
  CapturedSurface,
  RoomObject,
} from "../../../shared/contracts";
import type { ParametricModel as ParametricModelData } from "../../../shared/assets/model";
import { localCorners, worldCorners } from "../../../shared/capture/roomplan";
import type { Walkthrough } from "../../../shared/capture/walkthrough";
import { FirstPersonCamera, type WalkInput } from "./FirstPersonCamera";
import { surfaceGeometry } from "./surfaceGeometry";
import type { TexturedScan } from "../../../shared/capture/texture";
import { ScanSurface } from "./capture/ScanSurface";
import { ParametricModel } from "./ParametricModel";
import type { ReconstructedScene } from "../../../shared/reconstruction/contracts";
import { SimulatedArchitecture } from "./reconstruction/SimulatedArchitecture";
import {
  MaterialEnvironment,
  MaterialResources,
} from "./reconstruction/SurfaceMaterial";
import { SceneLighting } from "./reconstruction/SceneLighting";
import { SceneEffects } from "./reconstruction/SceneEffects";

function Surface({
  value,
  openings,
}: {
  value: CapturedSurface;
  openings: CapturedSurface[];
}) {
  const geometry = useMemo(
    () => surfaceGeometry(value, openings),
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
        color={value.kind === "floor" ? "#f7f6f2" : "#f1ece2"}
        side={DoubleSide}
        roughness={0.95}
      />
      <Edges color={value.kind === "floor" ? "#b9c0bc" : "#d9cfbc"} />
    </mesh>
  );
}

function Furniture({
  object,
  model,
  selected,
  onSelect,
  groupRef,
  invalid = false,
  modelStatus,
}: {
  object: RoomObject;
  model?: Pick<ParametricModelData, "label" | "parts" | "dimensions">;
  selected: boolean;
  onSelect: (id: string) => void;
  groupRef?: RefObject<Group>;
  invalid?: boolean;
  modelStatus?: "ready" | "pending" | "failed" | "placeholder";
}) {
  const { width, height, depth } = object.dimensions;
  return (
    <group
      ref={groupRef}
      position={[object.position.x, object.position.y, object.position.z]}
      rotation={[object.rotation.x, object.rotation.y, object.rotation.z]}
      onClick={(event) => {
        event.stopPropagation();
        if (event.delta < 5) onSelect(object.id);
      }}
    >
      {model ? (
        <ParametricModel model={model} dimensions={object.dimensions} />
      ) : (
        <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[width, height, depth]} />
          <meshStandardMaterial
            color={selected ? "#1e6b63" : object.color}
            roughness={0.85}
            transparent={Boolean(object.productId)}
            opacity={object.productId ? 0.3 : 1}
          />
          <Edges color={selected ? "#124f49" : "#5a5044"} />
        </mesh>
      )}
      {!model && object.productId && !selected && (
        <Html
          position={[0, height + 0.12, 0]}
          center
          style={{ pointerEvents: "none" }}
          className="rounded-lg bg-chalk px-2 py-1 text-[10px] whitespace-nowrap text-mute shadow-lift"
        >
          {modelStatus === "failed"
            ? "Model failed · size preview"
            : "Preparing model · size preview"}
        </Html>
      )}
      {selected && (
        <mesh position={[0, height / 2, 0]}>
          <boxGeometry args={[width + 0.015, height + 0.015, depth + 0.015]} />
          <meshBasicMaterial
            color={invalid ? "#a94e37" : "#1e6b63"}
            wireframe
            transparent
            opacity={0.8}
            depthTest={false}
          />
        </mesh>
      )}
      {selected && (
        <Html
          position={[0, height + 0.2, 0]}
          center
          className="rounded-lg bg-chalk px-2.5 py-1.5 text-xs whitespace-nowrap text-teal-deep shadow-lift"
          style={{ pointerEvents: "none" }}
        >
          <span className="block max-w-[260px] truncate font-semibold" title={object.name}>{object.name}</span>
          {!model && object.productId && (
            <small className="block text-mute">
              {modelStatus === "failed"
                ? "Model failed. Retry from Products."
                : "Preparing model. Showing size preview."}
            </small>
          )}
          <small className="block text-[10px] text-mute tabular-nums">
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
  // Fit once per room/view. Resizing a sidebar must not overwrite an orbit.
  const [initialViewport] = useState(viewport);
  const zoom = Math.max(
    8,
    Math.min(
      initialViewport.width / (width + 2),
      initialViewport.height / (depth + 2),
    ),
  );
  // OrbitControls owns the live camera transform. Keep these defaults stable
  // so unrelated renders do not copy them back over the user's view.
  const center = useMemo(
    () => new Vector3(width / 2, top ? 0 : height / 2, depth / 2),
    [width, height, depth, top],
  );
  const verticalFov = (42 * Math.PI) / 180;
  const horizontalFov =
    2 *
    Math.atan(
      (Math.tan(verticalFov / 2) * initialViewport.width) /
        initialViewport.height,
    );
  const radius = Math.hypot(width, height, depth) / 2;
  const distance =
    (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.05;
  const position = useMemo(
    () =>
      top
        ? new Vector3(width / 2, size * 2, depth / 2)
        : new Vector3(0.95, 1.1, 1.15)
            .normalize()
            .multiplyScalar(distance)
            .add(center),
    [top, width, size, depth, distance, center],
  );
  return (
    <>
      {top ? (
        <OrthographicCamera
          makeDefault
          position={position}
          zoom={zoom}
          up={[0, 0, -1]}
          near={0.05}
          far={size * 30}
        />
      ) : (
        <PerspectiveCamera
          makeDefault
          position={position}
          fov={42}
          near={0.05}
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
      <div
        className="grid h-full place-items-center p-8 text-center text-mute"
        role="alert"
      >
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
  scan,
  onScanError,
  walkthrough,
  walkInput,
  walkSession,
  assetScenes = {},
  assetStates = {},
  reconstruction,
  cutaway = true,
  preview,
  previewInvalid = false,
  editMode = "select",
  snap = true,
  onPreview,
  onCommit,
}: {
  room: CapturedRoom;
  selected: string | null;
  onSelect: (id: string | null) => void;
  top: boolean;
  wallsVisible: boolean;
  dimensionsVisible: boolean;
  scan?: TexturedScan;
  onScanError: (message: string) => void;
  walkthrough: Walkthrough | null;
  walkInput: RefObject<WalkInput>;
  walkSession: number;
  /** Validated scenes keyed by RoomObject.assetId. Missing scenes use a box. */
  assetScenes?: Readonly<Record<string, ParametricModelData>>;
  assetStates?: Readonly<
    Record<string, "ready" | "pending" | "failed" | "placeholder">
  >;
  reconstruction?: ReconstructedScene;
  cutaway?: boolean;
  preview?: RoomObject | null;
  previewInvalid?: boolean;
  editMode?: "select" | "move" | "rotate";
  snap?: boolean;
  onPreview?: (object: RoomObject) => void;
  onCommit?: (object: RoomObject) => void;
}) {
  const selectedGroup = useRef(new Group());
  const selectedObject = room.objects.find((object) => object.id === selected);
  function transformedObject() {
    if (!selectedObject) return null;
    const group = selectedGroup.current;
    return {
      ...selectedObject,
      position: {
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
      },
      rotation: { ...selectedObject.rotation, y: group.rotation.y },
    };
  }
  const reconstructed = useMemo(
    () =>
      new Map(
        reconstruction?.objects.map((object) => [object.objectId, clearFurnitureSurfaces(object)]) ??
          [],
      ),
    [reconstruction],
  );
  return (
    <ViewerBoundary key={room.id}>
      <Canvas
        shadows={{ type: PCFShadowMap }}
        frameloop={walkthrough ? "always" : "demand"}
        dpr={[1, 1.75]}
        onPointerMissed={() => {
          if (editMode === "select") onSelect(null);
        }}
        style={{ touchAction: walkthrough ? "none" : "auto" }}
        aria-label={
          walkthrough
            ? "First-person room. Drag to look, WASD or arrow keys to walk, Q and E to turn. Escape to exit."
            : "Interactive 3D room. Use the object list to select furniture with the keyboard."
        }
        fallback={
          <div className="grid h-full place-items-center p-8 text-center text-mute">
            WebGL is unavailable. Room measurements are still available in the
            object list.
          </div>
        }
      >
        <MaterialResources>
          <color
            attach="background"
            args={[reconstruction ? "#e9e2d6" : "#dce6dd"]}
          />
          {reconstruction && <MaterialEnvironment />}
          {reconstruction ? (
            <SceneLighting
              room={room}
              inside={!!walkthrough}
              scene={reconstruction}
              walls={wallsVisible}
              cutaway={cutaway}
            />
          ) : (
            <>
              <ambientLight intensity={1.5} />
              <directionalLight
                position={[3, 10, 5]}
                intensity={2}
                castShadow
                shadow-bias={-0.0003}
                shadow-normalBias={0.025}
                shadow-radius={3}
                shadow-mapSize={[2048, 2048]}
                shadow-camera-left={-12}
                shadow-camera-right={12}
                shadow-camera-top={12}
                shadow-camera-bottom={-12}
              />
            </>
          )}
          <Suspense fallback={null}>
            {(reconstruction || scan) && (
              <SceneEffects ambientOcclusion={!!reconstruction && !scan} />
            )}
            {walkthrough ? (
              <FirstPersonCamera
                key={walkSession}
                model={walkthrough}
                input={walkInput}
                width={room.dimensions.width}
                depth={room.dimensions.depth}
              />
            ) : (
              <Cameras
                key={`${room.id}-${top}-${room.dimensions.width}-${room.dimensions.height}-${room.dimensions.depth}`}
                room={room}
                top={top}
              />
            )}
            {scan && (
              <ScanSurface
                scan={scan}
                wallsVisible={wallsVisible}
                onError={onScanError}
                fallback={
                  <>
                    {room.floors.map((floor) => (
                      <Surface
                        key={floor.id}
                        value={floor}
                        openings={room.openings}
                      />
                    ))}
                    {wallsVisible &&
                      room.walls.map((wall) => (
                        <Surface
                          key={wall.id}
                          value={wall}
                          openings={room.openings}
                        />
                      ))}
                  </>
                }
              />
            )}
            {!scan && (
              <>
                {reconstruction ? (
                  <SimulatedArchitecture
                    room={room}
                    scene={reconstruction}
                    walls={wallsVisible}
                    inside={!!walkthrough}
                    cutaway={cutaway}
                  />
                ) : (
                  <>
                    {room.floors.map((floor) => (
                      <Surface key={floor.id} value={floor} openings={[]} />
                    ))}
                    {wallsVisible &&
                      room.walls.map((wall) => (
                        <Surface
                          key={wall.id}
                          value={wall}
                          openings={room.openings}
                        />
                      ))}
                    {room.openings.map((opening) => {
                      const points = worldCorners(opening);
                      points.push(points[0]);
                      return (
                        <Line
                          key={opening.id}
                          points={points}
                          color={
                            opening.kind === "window" ? "#5b7c99" : "#124f49"
                          }
                          lineWidth={2}
                        />
                      );
                    })}
                  </>
                )}
                {selectedObject &&
                  !selectedObject.locked &&
                  !walkthrough &&
                  editMode !== "select" && (
                    <TransformControls
                      key={`${selected}-${editMode}`}
                      object={selectedGroup}
                      mode={editMode === "move" ? "translate" : "rotate"}
                      space="world"
                      showX={editMode === "move"}
                      showY={
                        editMode === "rotate" || selectedObject.mount === "wall"
                      }
                      showZ={editMode === "move"}
                      translationSnap={snap ? 0.1 : null}
                      rotationSnap={snap ? Math.PI / 12 : null}
                      onObjectChange={() => {
                        const next = transformedObject();
                        if (next) onPreview?.(next);
                      }}
                      onMouseUp={() => {
                        const next = transformedObject();
                        if (next) onCommit?.(next);
                      }}
                    />
                  )}
                {room.objects.map((object) => (
                  <Furniture
                    key={object.id}
                    object={preview?.id === object.id ? preview : object}
                    modelStatus={
                      object.assetId ? assetStates[object.assetId] : undefined
                    }
                    groupRef={
                      selected === object.id ? selectedGroup : undefined
                    }
                    invalid={selected === object.id && previewInvalid}
                    model={
                      reconstructed.has(object.id)
                        ? {
                            ...reconstructed.get(object.id)!,
                            dimensions: object.dimensions,
                          }
                        : object.assetId
                          ? assetScenes[object.assetId]
                          : undefined
                    }
                    selected={selected === object.id}
                    onSelect={onSelect}
                  />
                ))}
              </>
            )}
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
                    className="rounded bg-chalk/95 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-teal-deep tabular-nums"
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
        </MaterialResources>
      </Canvas>
    </ViewerBoundary>
  );
}
