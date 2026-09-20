import { Footprints } from "lucide-react";
import { Button, Chip, Segmented, cx } from "../../ui";

export type ViewMode = "3d" | "plan";

/** Floating view controls for the room viewer (top right). */
export function ViewerTools({
  view,
  hidden = false,
  onWalk,
  onView,
  walls,
  onWalls,
  dimensions,
  onDimensions,
  className,
  scan,
}: {
  view: ViewMode;
  hidden?: boolean;
  onWalk: () => void;
  onView: (view: ViewMode) => void;
  walls: boolean;
  onWalls: (on: boolean) => void;
  dimensions: boolean;
  onDimensions: (on: boolean) => void;
  /** Placement override, e.g. to clear a chat panel on the right. */
  className?: string;
  scan?: { visible: boolean; onChange: (value: boolean) => void };
}) {
  return (
    <div
      inert={hidden}
      aria-hidden={hidden}
      className={cx(
        "absolute top-4 z-20 flex flex-wrap justify-end items-center gap-2 max-w-[calc(100%-32px)] transition-[translate,opacity] duration-400 motion-reduce:transition-none",
        hidden && "-translate-y-24 opacity-0 pointer-events-none",
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
      {view === "3d" && (
        <Button data-walk-entry variant="primary" onClick={onWalk}>
          <Footprints /> Walk inside
        </Button>
      )}
      <Chip
        pressed={walls}
        onChange={onWalls}
        className="bg-chalk/85 shadow-lift border-transparent"
      >
        Walls
      </Chip>
      {scan && (
        <Chip
          pressed={scan.visible}
          onChange={scan.onChange}
          className="bg-chalk/85 shadow-lift border-transparent"
        >
          Captured surfaces
        </Chip>
      )}
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
