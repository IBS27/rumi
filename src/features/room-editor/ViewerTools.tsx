import { Chip, Segmented } from "../../ui";

export type ViewMode = "3d" | "plan";

/** Floating view controls for the room viewer (top right). */
export function ViewerTools({
  view,
  onView,
  walls,
  onWalls,
  dimensions,
  onDimensions,
}: {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  walls: boolean;
  onWalls: (on: boolean) => void;
  dimensions: boolean;
  onDimensions: (on: boolean) => void;
}) {
  return (
    <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
      <Segmented
        label="View"
        value={view}
        onChange={onView}
        options={[
          { value: "3d", label: "3D view" },
          { value: "plan", label: "Floor plan" },
        ]}
        className="bg-chalk/85 shadow-lift"
      />
      <Chip
        pressed={walls}
        onChange={onWalls}
        className="bg-chalk/85 shadow-lift border-transparent"
      >
        Walls
      </Chip>
      <Chip
        pressed={dimensions}
        onChange={onDimensions}
        className="bg-chalk/85 shadow-lift border-transparent"
      >
        Dimensions
      </Chip>
    </div>
  );
}
