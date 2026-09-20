import type { ReactNode } from "react";
import { Footprints } from "lucide-react";
import { Button, Chip, Segmented, cx } from "../../ui";

export type ViewMode = "3d" | "plan";

/** Floating view controls for the room viewer (top center). */
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
  simulation,
  cutaway,
  children,
}: {
  children?: ReactNode;
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
  simulation?: { visible: boolean; onChange: (value: boolean) => void };
  cutaway?: { visible: boolean; onChange: (value: boolean) => void };
}) {
  return (
    <div
      inert={hidden}
      aria-hidden={hidden}
      className={cx(
        "absolute left-4 top-4 z-20 flex flex-col items-center gap-3 max-w-[calc(100%-32px)] pointer-events-none transition-[translate,opacity] duration-400 motion-reduce:transition-none",
        hidden && "-translate-y-24 opacity-0 pointer-events-none",
        className ?? "right-4",
      )}
    >
      <div className="flex flex-wrap items-center justify-center gap-2 pointer-events-auto [&>button]:h-9 [&>button]:justify-center [&>button]:text-center [&>button]:leading-none">
        <Segmented
          label="View"
          value={view}
          onChange={onView}
          options={[
            { value: "3d", label: "3D view" },
            { value: "plan", label: "Floor plan" },
          ]}
          className="h-9 bg-chalk/85 shadow-lift [&>button]:inline-flex [&>button]:items-center [&>button]:justify-center [&>button]:text-center [&>button]:leading-none"
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
        {simulation && (
          <Chip
            pressed={simulation.visible}
            onChange={simulation.onChange}
            className="bg-chalk/85 shadow-lift border-transparent"
          >
            Simulated room
          </Chip>
        )}
        {scan && (
          <Chip
            pressed={scan.visible}
            onChange={scan.onChange}
            className="bg-chalk/85 shadow-lift border-transparent"
          >
            Captured surfaces
          </Chip>
        )}
        {cutaway && walls && simulation?.visible && view === "3d" && (
          <Chip
            pressed={cutaway.visible}
            onChange={cutaway.onChange}
            className="bg-chalk/85 shadow-lift border-transparent"
          >
            Cutaway
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
      <div className="flex w-fit max-w-[min(560px,100%)] flex-col gap-2 text-center leading-5 pointer-events-auto">
        {children}
      </div>
    </div>
  );
}
