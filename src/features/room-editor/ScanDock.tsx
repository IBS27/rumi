import type { ComponentType } from "react";
import {
  Armchair,
  Bath,
  BedDouble,
  Box,
  Flame,
  Frame,
  Lamp,
  Monitor,
  Refrigerator,
  Sofa,
  Table,
  Layers as Shelf,
  Square,
  WashingMachine,
} from "lucide-react";
import type { z } from "zod";
import {
  categorySchema,
  type CapturedRoom,
  type RoomObject,
} from "../../../shared/contracts";
import { floorArea } from "../../../shared/capture/surfaces";
import { FloatingPanel, Heading, Muted, cx } from "../../ui";
import { ObjectEditor } from "./ObjectEditor";

type Category = z.infer<typeof categorySchema>;
const icons: Partial<Record<Category, ComponentType<{ size?: number }>>> = {
  sofa: Sofa,
  chair: Armchair,
  table: Table,
  bed: BedDouble,
  desk: Table,
  lighting: Lamp,
  rug: Square,
  storage: Shelf,
  art: Frame,
  refrigerator: Refrigerator,
  washerDryer: WashingMachine,
  television: Monitor,
  fireplace: Flame,
  bathtub: Bath,
};

function ObjectRow({
  object,
  selected,
  onSelect,
}: {
  object: RoomObject;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = icons[object.category] ?? Box;
  const estimated = object.measurementSource !== "confirmed";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-expanded={selected}
      className={cx(
        "grid w-full grid-cols-[28px_1fr_auto] items-center gap-2 rounded-[10px] border-[1.5px] border-transparent py-1 pr-2 pl-1 text-left transition-colors cursor-pointer",
        selected ? "rounded-b-none border-teal bg-white" : "hover:bg-wash",
      )}
    >
      <span className="grid size-7 place-items-center rounded-lg bg-stone text-[#5a5044]">
        <Icon size={17} />
      </span>
      <span className="min-w-0">
        <strong className="block truncate font-semibold">{object.name}</strong>
        <Muted className="block text-[11px] tabular-nums">
          {selected && estimated
            ? "Not yet confirmed"
            : `${object.dimensions.width.toFixed(2)} × ${object.dimensions.depth.toFixed(2)} × ${object.dimensions.height.toFixed(2)} m`}
        </Muted>
      </span>
      <i
        aria-label={estimated ? "Estimated" : "Confirmed"}
        className={cx(
          "size-2 rounded-full",
          estimated ? "bg-[#d9b84b]" : "bg-teal",
        )}
      />
    </button>
  );
}

/** Floating summary of the scan with the selectable object list. */
export function ScanDock({
  room,
  selected,
  onSelect,
  originalObject,
  onSave,
  onReset,
  onRemove,
  captureWarnings,
}: {
  room: CapturedRoom;
  selected: string | null;
  onSelect: (id: string | null) => void;
  originalObject: (id: string) => RoomObject | undefined;
  onSave: (next: RoomObject) => void;
  onReset: (id: string) => void;
  onRemove: (id: string) => void;
  captureWarnings?: string[];
}) {
  const confirmed = room.objects.filter(
    (item) => item.measurementSource === "confirmed",
  ).length;
  return (
    <FloatingPanel
      aria-label="What the scan found"
      className="top-4 left-4 flex max-h-[calc(100%-32px)] w-[252px] flex-col overflow-auto"
    >
      <Heading>What the scan found</Heading>
      {captureWarnings?.map((warning, index) => (
        <Muted key={index} className="mt-2 text-xs">
          {warning}
        </Muted>
      ))}
      <div className="mt-1.5 grid gap-px text-xs text-[#5a5044]">
        <div>
          <b className="font-semibold text-ink">{room.walls.length}</b> wall
          segments,{" "}
          <b className="font-semibold text-ink">{room.objects.length}</b>{" "}
          objects, {confirmed} confirmed
        </div>
        <div>
          <b className="font-semibold text-ink">
            {room.floors.length
              ? `${floorArea(room.floors).toFixed(1)} m²`
              : "Unknown"}
          </b>{" "}
          of floor
        </div>
        <div>
          <b className="font-semibold text-ink tabular-nums">
            {room.dimensions.width.toFixed(2)} ×{" "}
            {room.dimensions.depth.toFixed(2)} ×{" "}
            {room.dimensions.height.toFixed(2)} m
          </b>{" "}
          at the widest
        </div>
      </div>

      <ul className="mt-2.5 grid gap-0.5">
        {room.objects.map((object) => (
          <li key={object.id}>
            <ObjectRow
              object={object}
              selected={selected === object.id}
              onSelect={() =>
                onSelect(selected === object.id ? null : object.id)
              }
            />
            {selected === object.id && (
              <ObjectEditor
                key={`${object.id}-${room.revision}`}
                object={object}
                canReset={!!originalObject(object.id)}
                onSave={onSave}
                onReset={() => onReset(object.id)}
                onRemove={() => onRemove(object.id)}
              />
            )}
          </li>
        ))}
      </ul>
      {room.objects.length === 0 && (
        <Muted className="mt-2 text-xs">
          The scan found no furniture. Add items later from the design.
        </Muted>
      )}

      <div className="mt-2.5 flex gap-3 text-[11px] text-mute">
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-full bg-teal" /> confirmed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2 rounded-full bg-[#d9b84b]" /> estimated
        </span>
      </div>
    </FloatingPanel>
  );
}
