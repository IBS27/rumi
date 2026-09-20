import { useState, type ComponentType } from "react";
import {
  Armchair,
  Bath,
  BedDouble,
  Box,
  Flame,
  Frame,
  Lamp,
  ArrowLeft,
  ArrowRight,
  Monitor,
  PanelLeft,
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
import { Button, FloatingPanel, Heading, Muted, cx } from "../../ui";
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

function DockToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? "Hide the scan list" : "Show the scan list";
  const Arrow = open ? ArrowLeft : ArrowRight;
  return (
    <Button
      size="sm"
      variant="quiet"
      className="group size-7 shrink-0 p-1 text-mute"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
    >
      <PanelLeft size={17} className="group-hover:hidden" />
      <Arrow size={17} className="hidden group-hover:block" />
    </Button>
  );
}

/** Floating summary of the scan with the selectable object list. */
export function ScanDock({
  hidden = false,
  room,
  selected,
  onSelect,
  originalObject,
  onSave,
  onReset,
  onRemove,
  captureWarnings,
}: {
  hidden?: boolean;
  room: CapturedRoom;
  selected: string | null;
  onSelect: (id: string | null) => void;
  originalObject: (id: string) => RoomObject | undefined;
  onSave: (next: RoomObject) => void;
  onReset: (id: string) => void;
  onRemove: (id: string) => void;
  captureWarnings?: string[];
}) {
  const [open, setOpen] = useState(true);
  const confirmed = room.objects.filter(
    (item) => item.measurementSource === "confirmed",
  ).length;
  // The dock slides out for the walkthrough (`hidden`) or when collapsed here.
  const away = hidden || !open;
  return (
    <>
      {!hidden && !open && (
        <FloatingPanel
          aria-label="What the scan found"
          className="top-28 lg:top-4 left-4 p-1.5"
        >
          <DockToggle open={false} onToggle={() => setOpen(true)} />
        </FloatingPanel>
      )}
    <FloatingPanel
      aria-label="What the scan found"
      inert={away}
      aria-hidden={away}
      className={cx(
        "top-28 lg:top-4 left-4 flex max-h-[calc(100%-128px)] lg:max-h-[calc(100%-32px)] w-[252px] flex-col overflow-auto transition-[translate,opacity] duration-400 ease-in-out motion-reduce:transition-none",
        away &&
          "-translate-x-[calc(100%+32px)] opacity-0 pointer-events-none",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Heading>What the scan found</Heading>
        <DockToggle open onToggle={() => setOpen(false)} />
      </div>
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
    </>
  );
}
