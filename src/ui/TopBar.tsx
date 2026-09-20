import type { ReactNode } from "react";
import { cx } from "./cx";

/** The wordmark. Lowercase, display face, deep teal. */
export function Brand() {
  return (
    <span className="font-display text-[21px] leading-none font-semibold tracking-[-0.01em] text-teal-deep">
      rumi
    </span>
  );
}

/**
 * App header: brand, an optional title, then actions pushed to the right.
 * `brand` replaces the plain wordmark, e.g. with a menu button around it.
 */
export function TopBar({
  brand,
  title,
  children,
  className,
}: {
  brand?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx("flex shrink-0 items-center gap-4 px-5 py-2.5", className)}
    >
      {brand ?? <Brand />}
      {title && (
        <div className="flex items-center gap-2.5 font-display text-base font-medium">
          {title}
        </div>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-2.5">{children}</div>
    </header>
  );
}
