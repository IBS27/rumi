import type { ReactNode } from "react";
import { cx } from "./cx";

/** Chat turns share a speaker label and a distinct surface for each role. */
export function MessageBubble({
  speaker,
  card = false,
  children,
}: {
  speaker: "user" | "assistant" | "system";
  card?: boolean;
  children: ReactNode;
}) {
  const user = speaker === "user";
  return (
    <div className={cx("min-w-0 shrink-0", user ? "ml-6 self-end" : "mr-3")}>
      <span
        className={cx(
          "mb-1.5 block px-1 text-[11px] font-medium",
          user ? "text-right text-mute" : "text-teal-deep",
        )}
      >
        {user ? "You" : speaker === "system" ? "Notice" : "Rumi"}
      </span>
      <div
        className={cx(
          "text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]",
          user
            ? "rounded-panel rounded-br-sm bg-teal-tint/65 px-3.5 py-2.5"
            : card
              ? ""
              : "rounded-panel rounded-tl-sm border border-line/50 bg-white/75 px-3.5 py-3",
        )}
      >
        {children}
      </div>
    </div>
  );
}
