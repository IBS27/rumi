import { Chip, Segmented, cx } from "../../ui";

export type ViewMode = "3d" | "plan";

/** Floating view controls for the room viewer (top right). */
export function ViewerTools({
  view,
  onView,
  walls,
  onWalls,
  dimensions,
  onDimensions,
  className,
}: {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  walls: boolean;
  onWalls: (on: boolean) => void;
  dimensions: boolean;
  onDimensions: (on: boolean) => void;
  /** Placement override, e.g. to clear a chat panel on the right. */
  className?: string;
}) {
  return (
    <div
      className={cx(
        "absolute top-4 z-10 flex items-center gap-2",
        className ?? "right-4",
      )}
    >
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
