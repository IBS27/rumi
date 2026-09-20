import { cx } from "./cx";

/** Exclusive choice between a few views. Renders real buttons with aria-pressed. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx("inline-flex rounded-tile bg-wash p-[3px]", className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-[9px] px-2.5 py-[5px] font-medium text-mute transition-colors cursor-pointer",
            value === option.value && "bg-white text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
