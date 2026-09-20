import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** Section heading inside a panel. */
export function Heading({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cx("font-display text-base font-medium", className)}
      {...rest}
    />
  );
}

/** Large screen title, e.g. on the start screen. */
export function Display({
  className,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cx(
        "font-display text-[40px] leading-[1.05] font-medium tracking-[-0.02em] text-teal-deep",
        className,
      )}
      {...rest}
    />
  );
}

/** Secondary copy. */
export function Muted({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <span className={cx("text-mute", className)} {...rest} />;
}
