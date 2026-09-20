import type { ReactNode } from "react";
import { cx } from "./cx";

/** A small on/off toggle for overlays and filters. */
export function Chip({
  pressed,
  onChange,
  children,
  className,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cx(
        "inline-flex items-center gap-[7px] rounded-full border-[1.5px] px-2.5 py-[5px] text-xs font-medium whitespace-nowrap transition-colors cursor-pointer",
        pressed
          ? "border-teal bg-teal/8 text-teal-deep"
          : "border-line text-mute",
        className,
      )}
    >
      <span className="size-2 rounded-full bg-current" aria-hidden />
      {children}
    </button>
  );
}
