import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";

export type NoticeTone = "info" | "warn" | "error";

const tones: Record<NoticeTone, string> = {
  info: "bg-blue text-[#2e4656]",
  warn: "bg-ochre text-ochre-ink",
  error: "bg-blush text-rust",
};

/**
 * Inline message. Say what happened and what to do next.
 * Add `floating` to place it over the room view (top centre).
 */
export function Notice({
  tone = "info",
  floating,
  onDismiss,
  action,
  children,
  className,
}: {
  tone?: NoticeTone;
  floating?: boolean;
  onDismiss?: () => void;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "flex items-center gap-3 rounded-tile px-3.5 py-2.5 text-[13px]",
        tones[tone],
        floating &&
          "absolute top-4 left-1/2 z-20 w-[min(560px,calc(100%-32px))] -translate-x-1/2 shadow-float",
        className,
      )}
    >
      <div className="min-w-0 flex-1 overflow-wrap-anywhere">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 rounded-md p-1 hover:bg-white/50 cursor-pointer"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
