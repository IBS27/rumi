import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  MessageCircle,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import type { RoomObject } from "../../../shared/contracts";
import { Button, Checkbox, Muted, Segmented } from "../../ui";

export type EditMode = "select" | "move" | "rotate";
export interface EditControlProps {
  editMode?: EditMode;
  onEditMode?: (mode: EditMode) => void;
  snap?: boolean;
  onSnap?: (snap: boolean) => void;
  onPreview?: (object: RoomObject) => void;
  onAsk?: () => void;
  onArrange?: () => void;
}

export function EditControls({
  object,
  busy,
  onMove,
  editMode = "select",
  onEditMode,
  snap = true,
  onSnap,
  onAsk,
  onArrange,
}: EditControlProps & {
  object: RoomObject;
  busy?: boolean;
  onMove: (object: RoomObject) => void;
}) {
  const shift = (x: number, z: number, turn = 0) =>
    onMove({
      ...object,
      position: {
        ...object.position,
        x: object.position.x + x,
        z: object.position.z + z,
      },
      rotation: { ...object.rotation, y: object.rotation.y + turn },
    });
  return (
    <div className="my-2 space-y-2 border-y border-line py-2">
      <Button
        size="sm"
        variant="quiet"
        className="w-full justify-start"
        onClick={onAsk}
      >
        <MessageCircle /> Ask Rumi about this
      </Button>
      {!object.locked && (
        <>
          {object.productId && onArrange && (
            <Button
              size="sm"
              disabled={busy}
              onClick={onArrange}
              className="w-full"
            >
              Find a good spot
            </Button>
          )}
          {onEditMode && (
            <Segmented
              label="Edit placement"
              value={editMode}
              onChange={onEditMode}
              options={[
                { value: "select", label: "Select" },
                { value: "move", label: "Move" },
                { value: "rotate", label: "Rotate" },
              ]}
            />
          )}
          <div
            role="group"
            aria-label="Adjust placement"
            className="grid grid-cols-3 gap-1"
          >
            <Button
              size="sm"
              disabled={busy}
              aria-label="Move item north"
              onClick={() => shift(0, -0.1)}
            >
              <ArrowUp />
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Move item south"
              onClick={() => shift(0, 0.1)}
            >
              <ArrowDown />
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Rotate item left"
              onClick={() => shift(0, 0, -Math.PI / 12)}
            >
              <RotateCcw />
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Move item west"
              onClick={() => shift(-0.1, 0)}
            >
              <ArrowLeft />
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Move item east"
              onClick={() => shift(0.1, 0)}
            >
              <ArrowRight />
            </Button>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Rotate item right"
              onClick={() => shift(0, 0, Math.PI / 12)}
            >
              <RotateCw />
            </Button>
          </div>
          <Muted className="block text-[11px]">
            Arrows move 10 cm. Rotation turns 15°.
          </Muted>
          {onSnap && (
            <Checkbox
              checked={snap}
              onChange={(event) => onSnap(event.target.checked)}
              label="Snap handles to 10 cm / 15°"
            />
          )}
        </>
      )}
      {object.locked && (
        <Muted className="block text-xs">
          Unlock “Keep in place” to move this item.
        </Muted>
      )}
    </div>
  );
}
