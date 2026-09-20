import { useEffect, type RefObject } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  LogOut,
  RotateCcw,
} from "lucide-react";
import { Button, FloatingPanel, Pill } from "../../ui";
import type { WalkInput } from "./FirstPersonCamera";

const directions = [
  {
    value: "forward",
    label: "Move forward",
    icon: ArrowUp,
    className: "col-start-2",
  },
  {
    value: "left",
    label: "Move left",
    icon: ArrowLeft,
    className: "col-start-1 row-start-2",
  },
  {
    value: "backward",
    label: "Move backward",
    icon: ArrowDown,
    className: "col-start-2 row-start-2",
  },
  {
    value: "right",
    label: "Move right",
    icon: ArrowRight,
    className: "col-start-3 row-start-2",
  },
];

export function WalkControls({
  name,
  synthetic,
  input,
  onExit,
  onReset,
}: {
  name: string;
  synthetic: boolean;
  input: RefObject<WalkInput>;
  onExit: () => void;
  onReset: () => void;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onExit]);

  return (
    <>
      <FloatingPanel
        aria-label="First-person view"
        className="top-4 left-4 right-4 flex items-center justify-between gap-3 sm:right-auto sm:max-w-[calc(100%-32px)]"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-mute">
            First person {synthetic && <Pill>sample</Pill>}
          </div>
          <p className="truncate font-display text-base text-ink">{name}</p>
        </div>
        <Button autoFocus onClick={onExit}>
          <LogOut /> Exit first person
        </Button>
      </FloatingPanel>
      <FloatingPanel
        aria-label="Walk controls"
        className="bottom-4 left-4 flex max-w-[calc(100%-32px)] items-end gap-4 sm:items-center"
      >
        <div
          className="grid shrink-0 grid-cols-3 gap-1.5"
          role="group"
          aria-label="Movement"
        >
          {directions.map(({ value, label, icon: Icon, className }) => (
            <Button
              key={value}
              aria-label={label}
              className={`${className} size-11 touch-none select-none p-0`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                input.current.pressed.add(value);
              }}
              onPointerUp={() => input.current.pressed.delete(value)}
              onPointerCancel={() => input.current.pressed.delete(value)}
              onLostPointerCapture={() => input.current.pressed.delete(value)}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  input.current.pressed.add(value);
                }
              }}
              onKeyUp={() => input.current.pressed.delete(value)}
              onBlur={() => input.current.pressed.delete(value)}
              onContextMenu={(event) => event.preventDefault()}
            >
              <Icon />
            </Button>
          ))}
        </div>
        <div className="min-w-0 max-w-48 text-xs text-mute">
          <p className="font-medium text-ink">Drag the room to look around.</p>
          <p className="mt-1">Hold the arrows to walk.</p>
          <p className="mt-1 hidden sm:block">
            WASD / arrow keys to move · Q / E to turn · Esc to exit
          </p>
          <Button size="sm" variant="quiet" className="mt-2" onClick={onReset}>
            <RotateCcw /> Reset position
          </Button>
        </div>
      </FloatingPanel>
    </>
  );
}
