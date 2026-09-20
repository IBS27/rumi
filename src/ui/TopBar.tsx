import type { ReactNode } from "react";
import { cx } from "./cx";

/** The favicon and wordmark shared by app headers. */
export function Brand() {
  return (
    <span className="inline-flex items-center gap-2 font-display text-[21px] leading-none font-semibold tracking-[-0.01em] text-teal-deep">
      <img
        src="/favicon.svg"
        alt=""
        width={24}
        height={24}
        className="size-6 shrink-0"
      />
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
