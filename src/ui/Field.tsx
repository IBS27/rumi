import type {
  ComponentPropsWithRef,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { cx } from "./cx";

const control =
  "w-full min-w-0 rounded-lg border-[1.5px] border-line bg-chalk px-2 py-[5px] text-[13px] text-ink hover:border-line-strong";

/** Label above a control. Keep labels to one or two words. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-0.5 flex items-center justify-between gap-2 text-[10px] text-[#6b7a86]">
        <span>{label}</span>
        {hint && <span>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function TextInput({
  className,
  ...rest
}: ComponentPropsWithRef<"input">) {
  return <input className={cx(control, className)} {...rest} />;
}

/** Numeric input; pass `step`, `min`, `max` as usual. Values are meters or degrees. */
export function NumberInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="number"
      inputMode="decimal"
      className={cx(control, "tabular-nums", className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(control, className)} {...rest} />;
}

export function Checkbox({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cx("flex items-center gap-2 text-xs", className)}>
      <input type="checkbox" className="size-3.5 accent-teal" {...rest} />
      {label}
    </label>
  );
}

/** Multiline input, optionally embedded in a composer with its own border. */
export function TextArea({
  className,
  embedded = false,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { embedded?: boolean }) {
  return (
    <textarea
      className={cx(
        embedded ? "min-w-0 bg-transparent text-ink outline-none" : control,
        "resize-none placeholder:text-mute",
        className,
      )}
      {...rest}
    />
  );
}
