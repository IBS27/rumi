import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type PanelTone = "chalk" | "stone" | "sage" | "blue" | "blush";

const tones: Record<PanelTone, string> = {
  chalk: "bg-chalk",
  stone: "bg-stone",
  sage: "bg-sage",
  blue: "bg-blue",
  blush: "bg-blush",
};

/** A tinted plaster surface. Use for grouped content that sits in the flow. */
export function Panel({
  tone = "chalk",
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { tone?: PanelTone }) {
  return (
    <section
      className={cx("rounded-panel p-3.5", tones[tone], className)}
      {...rest}
    />
  );
}

/**
 * A panel that floats above the room view. Position it with `className`
 * (e.g. "left-4 top-4 w-[252px]"). Translucent chalk, one soft shadow.
 */
export function FloatingPanel({
  className,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cx(
        "absolute z-10 rounded-panel bg-chalk/95 p-3.5 shadow-float",
        className,
      )}
      {...rest}
    />
  );
}
