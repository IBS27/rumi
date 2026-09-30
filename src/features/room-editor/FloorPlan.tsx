import type { CapturedRoom } from "../../../shared/contracts";
import { worldCorners } from "../../../shared/capture/roomplan";
import { cx } from "../../ui";

/** A DOM/SVG fallback remains usable without WebGL or the Three.js chunk. */
export function FloorPlan({
  room,
  selected,
  onSelect,
}: {
  room: CapturedRoom;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { width, depth } = room.dimensions;
  return (
    <div className="h-full w-full bg-sage p-12">
      <svg
        className="h-full w-full"
        viewBox={`-0.5 -0.5 ${width + 1} ${depth + 1}`}
        aria-label="Room floor plan"
        role="img"
      >
        {room.floors.length ? (
          room.floors.map((floor) => (
            <polygon
              key={floor.id}
              points={worldCorners(floor)
                .map((point) => `${point.x},${point.z}`)
                .join(" ")}
              className="fill-chalk stroke-mute"
              strokeWidth={0.025}
            />
          ))
        ) : (
          <rect
            width={width}
            height={depth}
            className="fill-chalk stroke-mute"
            strokeWidth={0.025}
          />
        )}
        {room.objects.map((object) => (
          <g
            key={object.id}
            transform={`translate(${object.position.x} ${object.position.z}) rotate(${(-object.rotation.y * 180) / Math.PI})`}
          >
            <rect
              x={-object.dimensions.width / 2}
              y={-object.dimensions.depth / 2}
              width={object.dimensions.width}
              height={object.dimensions.depth}
              className={cx(
                // Keep keyboard focus on the meter scale of the SVG viewBox.
                "focus-visible:outline-none! focus-visible:[stroke-width:0.05] focus-visible:stroke-teal",
                selected === object.id
                  ? "fill-teal-tint stroke-teal"
                  : "fill-stone stroke-mute",
              )}
              strokeWidth={0.025}
              tabIndex={0}
              role="button"
              aria-label={`Select ${object.name}`}
              onClick={() => onSelect(object.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(object.id);
                }
              }}
            />
            <title>
              {object.name}: {object.dimensions.width.toFixed(2)} ×{" "}
              {object.dimensions.depth.toFixed(2)} m
            </title>
          </g>
        ))}
      </svg>
    </div>
  );
}
