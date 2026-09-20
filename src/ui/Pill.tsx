import type { ReactNode } from "react";
import { cx } from "./cx";

export type PillTone = "neutral" | "estimated" | "ok" | "warn" | "locked";

const tones: Record<PillTone, string> = {
  neutral: "bg-stone text-[#5a5044]",
  estimated: "bg-ochre text-ochre-ink",
  ok: "bg-teal-tint text-teal-deep",
  warn: "bg-ochre text-ochre-ink",
  locked: "bg-teal-deep text-white",
};

/** Short status label. `estimated` and `warn` are the only ochre uses in the UI. */
export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-medium leading-none [&>svg]:size-3",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
